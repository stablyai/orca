import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { subscribeRemoteRuntimeRequest } from '../../../shared/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  addEnvironmentFromPairingCode,
  resolveEnvironment
} from '../../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../../shared/runtime-environments'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../runtime/runtime-rpc'
import { makeStore, SESSION_WORKTREE_ID } from '../../runtime/paired-client-navigation-test-harness'
import { resetSharedControlSupport } from './runtime-environment-shared-control-support'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

const TABS = 17
const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  resetSharedControlSupport()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

function publish(runtime: OrcaRuntimeService, snapshotVersion: number, changedTab: number): void {
  const tabs = Array.from({ length: TABS }, (_, index) => ({
    type: 'terminal' as const,
    id: `tab-${index}`,
    parentTabId: `tab-${index}`,
    leafId: `pane:${index + 1}`,
    ptyId: `pty-${index + 1}`,
    title:
      index === changedTab
        ? `Claude Code: running pnpm test (step ${snapshotVersion})`
        : `Claude Code: waiting for input in worktree ${index}`,
    isActive: index === 0
  }))
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: SESSION_WORKTREE_ID,
        publicationEpoch: 'renderer:host',
        snapshotVersion,
        activeGroupId: 'group-1',
        activeTabId: 'tab-0',
        activeTabType: 'terminal',
        tabGroups: [{ id: 'group-1', activeTabId: 'tab-0', tabOrder: tabs.map((tab) => tab.id) }],
        tabs
      }
    ]
  })
}

type Received = { frames: unknown[]; bytes: number }

function recorder(): Received & { onResponse: (response: RuntimeRpcResponse<unknown>) => void } {
  const received: Received = { frames: [], bytes: 0 }
  return Object.assign(received, {
    onResponse: (response: RuntimeRpcResponse<unknown>) => {
      if (response.ok) {
        received.frames.push(response.result)
        received.bytes += JSON.stringify(response.result).length
      }
    }
  })
}

describe('session.tabs tab delta across mixed client versions', () => {
  it('serves an old desktop full frames and a new desktop the same frames from deltas', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared paired-client harness store covers every store read this host makes.
    const runtime = new OrcaRuntimeService(makeStore() as never)
    runtime.attachWindow(1)
    runtime.markGraphReady(1)
    publish(runtime, 1, -1)
    for (let index = 0; index < TABS; index += 1) {
      runtime.registerPty(`pty-${index + 1}`, SESSION_WORKTREE_ID)
    }
    const hostDataPath = mkdtempSync(join(tmpdir(), 'orca-tab-delta-host-'))
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-tab-delta-client-'))
    cleanups.push(() => {
      rmSync(hostDataPath, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    })
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: hostDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    cleanups.push(() => server.stop())
    const pair = (name: string): string => {
      const offer = server.createPairingOffer({ address: '127.0.0.1', name, scope: 'runtime' })
      if (!offer.available) {
        throw new Error('pairing_unavailable')
      }
      return addEnvironmentFromPairingCode(userDataPath, { name, pairingCode: offer.pairingUrl }).id
    }

    // A desktop released before the delta: same handshake, minus the one capability.
    const legacy = recorder()
    const legacySubscription = await subscribeRemoteRuntimeRequest(
      getPreferredPairedRuntimeConnection(resolveEnvironment(userDataPath, pair('old-desktop'))),
      'session.tabs.subscribe',
      { worktree: `id:${SESSION_WORKTREE_ID}` },
      10_000,
      { onResponse: legacy.onResponse, onError: () => {}, onClose: () => {} },
      {
        clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES.filter(
          (capability) => capability !== SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY
        )
      }
    )
    cleanups.push(() => legacySubscription.close())

    // What a new desktop's socket carries before main decodes it.
    const wire = recorder()
    const wireSubscription = await subscribeRemoteRuntimeRequest(
      getPreferredPairedRuntimeConnection(resolveEnvironment(userDataPath, pair('new-wire'))),
      'session.tabs.subscribe',
      { worktree: `id:${SESSION_WORKTREE_ID}` },
      10_000,
      { onResponse: wire.onResponse, onError: () => {}, onClose: () => {} },
      { clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES }
    )
    cleanups.push(() => wireSubscription.close())

    // This desktop: the real main-process path, which decodes before the window sees a frame.
    const current = recorder()
    const currentSubscription = await subscribeRuntimeEnvironment(
      userDataPath,
      pair('new-desktop'),
      'session.tabs.subscribe',
      { worktree: `id:${SESSION_WORKTREE_ID}` },
      10_000,
      {
        onEvent: (event) => {
          if (event.type === 'response') {
            current.onResponse(event.response)
          }
        },
        onClose: () => {}
      }
    )
    cleanups.push(() => currentSubscription.close())

    await vi.waitFor(() => {
      expect(legacy.frames).toHaveLength(1)
      expect(current.frames).toHaveLength(1)
      expect(wire.frames).toHaveLength(1)
    })
    for (let version = 2; version <= 11; version += 1) {
      publish(runtime, version, version % 3)
      await vi.waitFor(() => {
        expect(legacy.frames).toHaveLength(version)
        expect(current.frames).toHaveLength(version)
        expect(wire.frames).toHaveLength(version)
      })
    }

    expect(current.frames).toEqual(legacy.frames)
    expect(legacy.frames.at(-1)).not.toHaveProperty('tabsDelta')
    expect(wire.frames.at(-1)).toHaveProperty('tabsDelta')
    const legacyUpdateBytes = legacy.bytes - JSON.stringify(legacy.frames[0]).length
    const wireUpdateBytes = wire.bytes - JSON.stringify(wire.frames[0]).length
    expect(wireUpdateBytes * 4).toBeLessThan(legacyUpdateBytes)
  }, 30_000)
})
