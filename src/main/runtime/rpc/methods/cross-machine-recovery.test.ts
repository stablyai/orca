import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AppEnvironment from '../../../../shared/app-environment'
import type { RecoveryPresentationPublishParams } from '../../../../shared/cross-machine-recovery-presentation-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { setRuntimeDesktopSurface } from '../../runtime-desktop-surface'
import { eraseRpcMethods, isStreamingMethod, type RpcContext, type RpcMethod } from '../core'
// Why: importing the methods module directly trips module-init cycles; the index resolves them.
import { ALL_RPC_METHODS } from './index'

const { profileDir } = vi.hoisted(() => ({ profileDir: { current: '' } }))

vi.mock('../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => profileDir.current
}))

vi.mock('../../../../shared/app-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof AppEnvironment>()),
  getAppEnvironment: () => ({ getVersion: () => '9.9.9' })
}))

beforeEach(() => {
  setRuntimeDesktopSurface({
    servesDesktopRenderer: () => true,
    showNotification: () => false,
    findWindowById: () => null,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
})

afterEach(() => setRuntimeDesktopSurface(null))

function method(name: string): RpcMethod {
  const found = eraseRpcMethods(ALL_RPC_METHODS).find((candidate) => candidate.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`missing ${name}`)
  }
  return found
}

async function call(name: string, params: unknown, ctx: Omit<RpcContext, 'runtime'>) {
  const target = method(name)
  const parsed = target.params ? target.params.parse(params) : undefined
  return await target.handler(parsed, { ...ctx, runtime })
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method the recovery describe/publish handlers reach.
const runtime = {
  getRuntimeId: () => 'runtime-1',
  readMachineName: () => 'studio',
  getStatus: () => ({ capabilities: ['cross-machine-recovery.workspace.v1'] })
} as unknown as OrcaRuntimeService

function publishParams(
  clientInstanceId: string,
  focusedTabId: string
): RecoveryPresentationPublishParams {
  return {
    clientInstanceId,
    clientName: 'Laptop',
    clientRevision: 1,
    workspaces: [
      {
        workspace: { kind: 'worktree', worktreeId: 'repo-1::/work/repo', instanceId: 'inst-1' },
        view: {
          tabs: [],
          groups: [],
          groupLayout: null,
          activeGroupId: null,
          terminalTabs: [],
          terminalLayouts: {},
          startupCwdRelative: {},
          editors: [],
          activeEditorRelativePath: null,
          browsers: [],
          activeBrowserId: null,
          activeTabType: null,
          activeTabId: null
        },
        focus: {
          isActiveWorkspace: true,
          focusedTabId,
          focusedLeafId: null,
          focusedPaneKey: null,
          windowFocused: true
        },
        input: { msSinceHumanInput: 1_000, msSinceHumanFocus: 500, msSinceHumanInputByPaneKey: {} }
      }
    ]
  }
}

beforeEach(() => {
  profileDir.current = mkdtempSync(join(tmpdir(), 'orca-xmr-rpc-'))
})

afterEach(() => {
  rmSync(profileDir.current, { recursive: true, force: true })
})

describe('crossMachineRecovery local-only gate', () => {
  const localOnly: [string, unknown][] = [
    ['crossMachineRecovery.describe', {}],
    ['crossMachineRecovery.export', { worktree: 'id:repo-1::/work/repo' }],
    ['crossMachineRecovery.list', {}],
    ['crossMachineRecovery.activity', {}],
    [
      'crossMachineRecovery.import',
      { descriptor: {}, checkoutPath: '/work/repo', checkpointId: 'checkpoint-1' }
    ],
    ['crossMachineRecovery.resume', { worktree: 'id:repo-1::/work/repo', binding: 'sess-1' }]
  ]
  const remoteCallers: Omit<RpcContext, 'runtime'>[] = [
    { clientKind: 'mobile' },
    { clientKind: 'runtime' },
    { pairedDeviceId: 'device-1' }
  ]

  for (const [name, params] of localOnly) {
    for (const caller of remoteCallers) {
      it(`refuses ${name} from ${JSON.stringify(caller)}`, async () => {
        await expect(call(name, params, caller)).rejects.toThrow('recovery_local_only')
      })
    }
  }

  it('takes no activity params', () => {
    const params = method('crossMachineRecovery.activity').params

    expect(params?.parse(undefined)).toEqual({})
    expect(() => params?.parse({ worktree: 'id:repo-1::/work/repo' })).toThrow()
  })

  it('describes this desktop with a persisted client instance id', async () => {
    const first = await call('crossMachineRecovery.describe', {}, {})
    const second = await call('crossMachineRecovery.describe', {}, {})

    expect(first).toEqual({
      protocol: 1,
      runtimeId: 'runtime-1',
      executionHostId: 'local',
      appVersion: '9.9.9',
      platform: process.platform,
      machineName: 'studio',
      hostKind: 'desktop',
      localClientInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      capabilities: ['cross-machine-recovery.workspace.v1']
    })
    expect(second).toEqual(first)
  })
})

describe('crossMachineRecovery.presentation.publish', () => {
  it('refuses callers without an authenticated paired device', async () => {
    await expect(
      call('crossMachineRecovery.presentation.publish', publishParams('laptop', 'tab-a'), {})
    ).rejects.toThrow('recovery_unsupported')
  })

  it('keys views by the authenticated device, never the payload instance id', async () => {
    const { getCrossMachineRecoveryPresentationStore } =
      await import('../../cross-machine-recovery/presentation-store-instance')
    await call('crossMachineRecovery.presentation.publish', publishParams('shared-id', 'tab-a'), {
      pairedDeviceId: 'device-a'
    })
    const spoof = await call(
      'crossMachineRecovery.presentation.publish',
      publishParams('shared-id', 'tab-b'),
      { pairedDeviceId: 'device-b' }
    )

    expect(spoof).toEqual({ ok: true, acknowledgedRevision: 1, hostReceivedAt: expect.any(Number) })
    const { views } = await getCrossMachineRecoveryPresentationStore().listForWorkspace(
      { kind: 'worktree', worktreeId: 'repo-1::/work/repo', instanceId: 'inst-1' },
      Date.now()
    )
    expect(
      views.map((view) => [view.clientKey, view.clientKind, view.focus.focusedTabId]).sort()
    ).toEqual([
      ['device:device-a', 'paired-device', 'tab-a'],
      ['device:device-b', 'paired-device', 'tab-b']
    ])
  })
})
