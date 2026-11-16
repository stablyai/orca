import '../../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { resetRuntimeEnvironmentStatusOwners } from '../connections/runtime-environment-request-connections'
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSharedControlTestServer,
  closeSharedControlTestServers
} from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import type { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { SshTarget } from '../../../../shared/remote-runtime/ssh/ssh-types'
import type { Store } from '../../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { installRealWorkerThreadChildProcesses } from '../../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { installDesktopSshGitExecution } from '../git-execution/desktop-ssh-git-execution'
import {
  desktopWorkspaceRecords,
  git
} from '../git-execution/desktop-ssh-git-execution.test-fixture'

const { sendRemoteRuntimeRequestOnSocketMock, sendRemoteRuntimeSharedControlRequestMock } =
  vi.hoisted(() => ({
    sendRemoteRuntimeRequestOnSocketMock: vi.fn(),
    sendRemoteRuntimeSharedControlRequestMock: vi.fn()
  }))

vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-request-socket', () => ({
  sendRemoteRuntimeRequestOnSocket: sendRemoteRuntimeRequestOnSocketMock
}))

vi.mock('../connections/runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('../runtime-environments-ipc-test-harness')
  return withRuntimeStatusOwners({
    sendRemoteRuntimeConnectionRequest: vi.fn(),
    sendRemoteRuntimeSharedControlRequest: sendRemoteRuntimeSharedControlRequestMock,
    reconnectRemoteRuntimeSharedControlConnection: vi.fn(),
    ensureRemoteRuntimeSharedControlConnection: vi.fn(),
    pauseRemoteRuntimeSharedControlRetry: vi.fn()
  })
})

import {
  callRuntimeEnvironment,
  subscribeRuntimeEnvironment
} from './runtime-environment-transport-routing'
import { resetSharedControlSupport } from '../connections/runtime-environment-shared-control-support'

const actual = await vi.importActual<{
  sendRemoteRuntimeRequestOnSocket: typeof sendRemoteRuntimeRequestOnSocket
}>('../../../../shared/remote-runtime/requests/remote-runtime-request-socket')

describe('federated read RPC transport routing', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-federated-read-routing-'))
    resetSharedControlSupport()
    sendRemoteRuntimeRequestOnSocketMock.mockReset()
    sendRemoteRuntimeSharedControlRequestMock.mockReset()
  })

  afterEach(async () => {
    await closeSharedControlTestServers()
    resetRuntimeEnvironmentStatusOwners()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('refuses a runtime-pinned one-shot mutation when its socket reaches a restarted host', async () => {
    const server = await createSharedControlTestServer({
      resultForRequest: (method) =>
        method === 'status.get' ? { runtimeId: 'runtime-restarted', capabilities: [] } : {}
    })
    const paired = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'Restarted host',
      pairingCode: encodePairingOffer(server.offer)
    })
    await markEnvironmentUsed(userDataPath, paired.id, { runtimeId: 'runtime-proven' })
    sendRemoteRuntimeRequestOnSocketMock.mockImplementation(actual.sendRemoteRuntimeRequestOnSocket)
    await expect(
      callRuntimeEnvironment(
        userDataPath,
        paired.id,
        'orchestration.federationRelease',
        { dispatchId: 'dispatch-1' },
        15_000,
        undefined,
        { orchestrationContractVersion: 1, orchestrationRequestId: 'release-1' },
        { expectedEnvironmentRuntimeId: 'runtime-proven' }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
    expect(
      server.requests.filter((request) => request.method === 'orchestration.federationRelease')
    ).toEqual([])
  })

  it('pushes on the desktop through unary and abortable environment transports', async () => {
    const checkout = join(userDataPath, 'checkout')
    const origin = join(userDataPath, 'origin.git')
    mkdirSync(checkout)
    await git(checkout, ['init', '-q'])
    await git(checkout, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await git(checkout, ['config', 'user.name', 'Desktop Git'])
    await git(checkout, ['config', 'user.email', 'desktop@example.test'])
    await git(checkout, ['config', 'commit.gpgsign', 'false'])
    await git(checkout, ['commit', '--allow-empty', '-qm', 'unary desktop push'])
    await git(checkout, ['init', '--bare', '-q', origin])
    await git(checkout, ['remote', 'add', 'origin', origin])
    const { repo, worktree } = desktopWorkspaceRecords(checkout)
    const server = await createSharedControlTestServer({
      resultForRequest: (method) => {
        if (method === 'status.get') {
          return { runtimeId: 'runtime-test', capabilities: [] }
        }
        if (method === 'repo.show') {
          return { repo }
        }
        if (method === 'worktree.show') {
          return { worktree: { ...worktree, git: worktree } }
        }
        return { success: false, error: 'Sandbox Git is read-only' }
      }
    })
    const paired = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'Mounted sandbox',
      pairingCode: encodePairingOffer(server.offer)
    })
    await markEnvironmentUsed(userDataPath, paired.id, { runtimeId: 'runtime-test' })
    const target: SshTarget = {
      id: 'sandbox',
      label: 'Sandbox',
      host: 'sandbox.test',
      port: 22,
      username: 'agent',
      generation: 1,
      orcadFence: { environmentId: paired.id },
      gitExecution: 'local'
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: transport routing reads saved SSH policy; these push operations need no other Store settings.
    const store = { getSshTargets: () => [target] } as Store
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production source-control facade supplies Git commands; dispatch reads only the desktop runtime identity.
    const runtime = { getRuntimeId: () => 'desktop-runtime' } as OrcaRuntimeService
    installDesktopSshGitExecution(store, runtime)
    sendRemoteRuntimeRequestOnSocketMock.mockImplementation(actual.sendRemoteRuntimeRequestOnSocket)
    sendRemoteRuntimeSharedControlRequestMock.mockImplementation(
      (_id, _connection, method, params, timeoutMs) =>
        actual.sendRemoteRuntimeRequestOnSocket(server.pairing, method, params, timeoutMs)
    )
    const params = { worktree: `id:${worktree.id}`, publish: true }

    expect(await callRuntimeEnvironment(userDataPath, paired.id, 'git.push', params)).toMatchObject(
      { ok: true, _meta: { runtimeId: 'runtime-test' } }
    )
    expect(await git(origin, ['show', '-s', '--format=%s', 'refs/heads/main'])).toBe(
      'unary desktop push'
    )

    await git(checkout, ['commit', '--allow-empty', '-qm', 'abortable desktop push'])
    const reply = Promise.withResolvers<RuntimeRpcResponse<unknown>>()
    const subscription = await subscribeRuntimeEnvironment(
      userDataPath,
      paired.id,
      'git.push',
      params,
      15_000,
      {
        onEvent: (event) => {
          if (event.type === 'response') {
            reply.resolve(event.response)
          }
          if (event.type === 'error') {
            reply.reject(new Error(event.message))
          }
        },
        onClose: () => {}
      },
      () => true,
      new AbortController().signal
    )
    try {
      expect(await reply.promise).toMatchObject({ ok: true, _meta: { runtimeId: 'runtime-test' } })
      expect(await git(origin, ['show', '-s', '--format=%s', 'refs/heads/main'])).toBe(
        'abortable desktop push'
      )
      expect(server.requests.filter((request) => request.method === 'git.push')).toEqual([])
    } finally {
      subscription.close()
    }
  })
})

installRealWorkerThreadChildProcesses()
