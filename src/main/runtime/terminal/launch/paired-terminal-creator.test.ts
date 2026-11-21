// `orca pair` in a terminal a paired client opened tags its link with that client; every way a
// client opens one must count, not only terminal.create.
import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { makeStore } from '../../rpc/server/runtime-rpc-worktree-store-fixtures'
import { partialRuntimeStore } from '../../construction/test-context/runtime-store-partial-fixture'
import { runWithActiveRpcCaller } from '../../rpc/callers/active-call'
import { pairedCreatorOfTerminal } from '../../rpc/server/pairing/paired-terminal-creators'
import { provisionWorktreeTerminals } from '../../workspaces/startup/runtime-worktree-terminal-provisioning'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { TERMINAL_LIFECYCLE_METHODS } from '../../rpc/methods/terminal/terminal-lifecycle-methods'
import { TERMINAL_IMAGE_VIEWER_CAPABILITY } from '../../../../shared/terminal/images/terminal-image-viewer-capability'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { bindPaneFirst } from '../layout/bind-first-pane.test-fixture'

const worktrees = vi.hoisted(() => [
  {
    path: '/tmp/worktree-a',
    head: 'abc',
    branch: 'feature/foo',
    isBare: false,
    isMainWorktree: false
  }
])
vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: vi.fn().mockResolvedValue(worktrees)
}))
vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
}))

const WORKTREE = 'repo-1::/tmp/worktree-a'
const PHONE = { kind: 'paired-device', deviceId: 'phone-1' } as const

function pairedRuntime() {
  const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))
  let next = 0
  const spawn = vi.fn<NonNullable<RuntimePtyController['spawn']>>(async (opts) => {
    const id = `pty-${++next}`
    const { worktreeId, tabId, leafId } = opts
    if (worktreeId && tabId && leafId) {
      bindPaneFirst(runtime, { worktreeId, tabId, leafId, ptyId: id })
    }
    return { id }
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

describe('terminals a paired client opens', () => {
  it('a split of the owner’s terminal is the client’s; the owner’s own is nobody’s', async () => {
    const { runtime } = pairedRuntime()
    const owners = await runtime.createTerminal(`id:${WORKTREE}`)

    const split = await runWithActiveRpcCaller(PHONE, () => runtime.splitTerminal(owners.handle))

    expect(pairedCreatorOfTerminal(split.handle)).toBe('phone-1')
    expect(pairedCreatorOfTerminal(owners.handle)).toBeUndefined()
  })

  it('an agent launch’s terminal is the client’s', async () => {
    const { runtime } = pairedRuntime()

    const launched = await runWithActiveRpcCaller(PHONE, () =>
      runtime.createTerminal(`id:${WORKTREE}`, { command: 'claude', launchAgent: 'claude' })
    )

    expect(pairedCreatorOfTerminal(launched.handle)).toBe('phone-1')
  })

  it('a new workspace’s setup terminal is the client’s', async () => {
    const { runtime } = pairedRuntime()
    type ProvisioningHost = Parameters<typeof provisionWorktreeTerminals>[0]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provisioning host is protected; the test takes it as workspace creation does.
    const internals = runtime as unknown as {
      getWorktreeTerminalProvisioningHost: () => ProvisioningHost
    }
    const host = internals.getWorktreeTerminalProvisioningHost()

    const provisioned = await runWithActiveRpcCaller(PHONE, () =>
      provisionWorktreeTerminals(host, {
        worktreeSelector: `id:${WORKTREE}`,
        worktreeId: WORKTREE,
        worktreePath: '/tmp/worktree-a',
        setup: { runnerScriptPath: '/tmp/worktree-a/.orca/setup.sh', envVars: {} },
        hasStartupTerminal: false,
        setupCommandPlatform: 'posix'
      })
    )

    expect(provisioned.setupTerminalHandle).not.toBeNull()
    expect(pairedCreatorOfTerminal(provisioned.setupTerminalHandle!)).toBe('phone-1')
  })

  it.each([
    ['runtime', '1'],
    ['mobile', '0'],
    [undefined, undefined]
  ] as const)('uses the %s caller’s capability for a blank split', async (clientKind, marker) => {
    const { runtime, spawn } = pairedRuntime()
    const source = await runtime.createTerminal(`id:${WORKTREE}`)
    const sourceSpawn = spawn.mock.lastCall?.[0]
    const target =
      ORCA_LAYOUT_OWNER_IS_MAIN && clientKind === 'runtime'
        ? { pane: { worktreeId: WORKTREE, tabId: sourceSpawn?.tabId, leafId: sourceSpawn?.leafId } }
        : { terminal: source.handle }
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_LIFECYCLE_METHODS })
    const response = await dispatcher.dispatch(
      {
        id: 'split',
        authToken: 'tok',
        method: 'terminal.split',
        params: {
          ...target,
          ...(clientKind
            ? { env: { ORCA_TERMINAL_IMAGE_VIEWER: clientKind === 'runtime' ? '0' : '1' } }
            : {})
        }
      },
      clientKind
        ? {
            clientKind,
            pairedDeviceId: 'split-viewer',
            ...(clientKind === 'runtime'
              ? { clientCapabilities: [TERMINAL_IMAGE_VIEWER_CAPABILITY] }
              : {})
          }
        : undefined
    )
    expect(response).toMatchObject({ ok: true })
    const split = spawn.mock.lastCall?.[0]
    expect(split).toBeDefined()
    expect(split?.command).toBeUndefined()
    expect(split?.env?.ORCA_TERMINAL_IMAGE_VIEWER).toBe(marker)
  })
})
