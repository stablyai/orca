import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as environmentStore from '../../../shared/runtime-environment-store'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime-client-error'

const { handleMock, getPathMock, sendRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getPathMock: vi.fn(),
  sendRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: getPathMock },
  ipcMain: {
    handle: handleMock,
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  }
}))

vi.mock('../../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeRequest: vi.fn()
}))

vi.mock('./runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('./runtime-environments-ipc-test-harness')
  return withRuntimeStatusOwners({
    sendRemoteRuntimeConnectionRequest: vi.fn(),
    sendRemoteRuntimeSharedControlRequest: vi.fn(() => new Promise(() => {})),
    subscribeRemoteRuntimeSharedControlRequest: vi.fn(),
    getRemoteRuntimeSharedControlDiagnostics: vi.fn(() => null),
    reconnectRemoteRuntimeSharedControlConnection: vi.fn(),
    retryRemoteRuntimeSharedControlConnectionsNow: vi.fn(),
    ensureRemoteRuntimeSharedControlConnection: vi.fn(),
    pauseRemoteRuntimeSharedControlRetry: vi.fn(),
    closeRemoteRuntimeRequestConnection: vi.fn()
  })
})

import { registerRuntimeEnvironmentHandlers } from './runtime-environments'
import {
  getRuntimeEnvironmentStatusOwner,
  getRuntimeEnvironmentStatusSnapshots,
  resetRuntimeEnvironmentStatusOwners
} from './runtime-environment-request-connections'
import { channelHandlerLookup, pairingCode } from './runtime-environments-ipc-test-harness'

const handler = channelHandlerLookup(handleMock)
const ENDPOINT = 'ws://192.168.1.20:6768'

function statusResponse() {
  return {
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'runtime-after-restart',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: 1,
      liveTabCount: 0,
      liveLeafCount: 0,
      protocolVersion: 999_999
    },
    _meta: { runtimeId: 'runtime-after-restart' }
  }
}

describe('runtimeEnvironments:repairFromPairingCode', () => {
  let userDataPath: string
  let repair: (event: unknown, args: { selector: string; pairingCode: string }) => unknown

  function savedToken(): string | undefined {
    return environmentStore.resolveEnvironment(userDataPath, 'desk').endpoints[0]?.deviceToken
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-repair-'))
    getPathMock.mockReturnValue(userDataPath)
    handleMock.mockReset()
    sendRemoteRuntimeRequestMock.mockReset()
    const store = {
      getSettings: () => ({ activeRuntimeEnvironmentId: null }),
      updateSettings: vi.fn(),
      removeWorkspaceSessionHost: vi.fn(),
      setRemoteLayoutSnapshot: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The registrar only reads the fixture's settings and workspace-session methods.
    registerRuntimeEnvironmentHandlers(store as never)
    environmentStore.addEnvironmentFromPairingCode(userDataPath, {
      name: 'desk',
      pairingCode: pairingCode(ENDPOINT, { deviceToken: 'revoked-token' })
    })
    repair = handler('runtimeEnvironments:repairFromPairingCode')
  })

  afterEach(() => {
    resetRuntimeEnvironmentStatusOwners()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('replaces a revoked pairing in place and clears the blocked status', async () => {
    const before = environmentStore.resolveEnvironment(userDataPath, 'desk')
    getRuntimeEnvironmentStatusOwner(userDataPath, before.id).authenticationRejected()
    expect(getRuntimeEnvironmentStatusSnapshots()).toMatchObject([
      { verification: 'blocked', blockedReason: 'access-revoked' }
    ])
    sendRemoteRuntimeRequestMock.mockResolvedValue(statusResponse())

    const result = await repair(null, {
      selector: 'desk',
      pairingCode: pairingCode(ENDPOINT, { deviceToken: 'fresh-token' })
    })

    expect(result).toMatchObject({
      ok: true,
      environment: { id: before.id, name: 'desk' },
      runtimeStatus: { runtimeId: 'runtime-after-restart' }
    })
    expect(JSON.stringify(result)).not.toContain('fresh-token')
    const after = environmentStore.resolveEnvironment(userDataPath, 'desk')
    expect(savedToken()).toBe('fresh-token')
    expect(after.pairingRevision).toBeGreaterThan(before.pairingRevision ?? before.createdAt)
    const snapshot = getRuntimeEnvironmentStatusSnapshots().find(
      (entry) => entry.environmentId === before.id
    )
    expect(snapshot).toMatchObject({
      verification: 'verified',
      pairingRevision: after.pairingRevision
    })
    expect(snapshot).not.toHaveProperty('blockedReason')
  })

  it('refuses a verified link for a different server and keeps the saved pairing', async () => {
    sendRemoteRuntimeRequestMock.mockResolvedValue(statusResponse())

    await expect(
      repair(null, {
        selector: 'desk',
        pairingCode: pairingCode(ENDPOINT, {
          deviceToken: 'other-token',
          keyByte: 2
        })
      })
    ).resolves.toEqual({
      ok: false,
      kind: 'different-server',
      message: 'This pairing link is for a different server.'
    })
    expect(savedToken()).toBe('revoked-token')
  })

  it('leaves the record untouched for an invalid or rejected link', async () => {
    const before = environmentStore.resolveEnvironment(userDataPath, 'desk')
    await expect(
      repair(null, { selector: 'desk', pairingCode: 'not a link' })
    ).resolves.toMatchObject({ ok: false, kind: 'access-link-invalid' })
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()

    sendRemoteRuntimeRequestMock.mockRejectedValue(
      new RemoteRuntimeClientError('unauthorized', 'rejected', {
        pairingStage: 'access-grant'
      })
    )
    await expect(
      repair(null, {
        selector: 'desk',
        pairingCode: pairingCode(ENDPOINT, { deviceToken: 'also-revoked' })
      })
    ).resolves.toMatchObject({ ok: false, kind: 'access-link-invalid' })
    expect(environmentStore.resolveEnvironment(userDataPath, 'desk')).toEqual(before)
  })

  it('declines a server another Orca service pairs', async () => {
    environmentStore.addEnvironmentFromPairingCode(userDataPath, {
      name: 'vm',
      pairingCode: pairingCode(ENDPOINT, { deviceToken: 'vm-token', keyByte: 2 }),
      source: 'ephemeral-vm'
    })
    await expect(
      repair(null, { selector: 'vm', pairingCode: pairingCode(ENDPOINT, { keyByte: 2 }) })
    ).resolves.toMatchObject({ ok: false, kind: 'environment-save-failed' })
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()
  })
})
