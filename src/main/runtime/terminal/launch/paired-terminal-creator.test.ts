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
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: `pty-${++next}` })),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return runtime
}

describe('terminals a paired client opens', () => {
  it('a split of the owner’s terminal is the client’s; the owner’s own is nobody’s', async () => {
    const runtime = pairedRuntime()
    const owners = await runtime.createTerminal(`id:${WORKTREE}`)

    const split = await runWithActiveRpcCaller(PHONE, () => runtime.splitTerminal(owners.handle))

    expect(pairedCreatorOfTerminal(split.handle)).toBe('phone-1')
    expect(pairedCreatorOfTerminal(owners.handle)).toBeUndefined()
  })

  it('an agent launch’s terminal is the client’s', async () => {
    const runtime = pairedRuntime()

    const launched = await runWithActiveRpcCaller(PHONE, () =>
      runtime.createTerminal(`id:${WORKTREE}`, { command: 'claude', launchAgent: 'claude' })
    )

    expect(pairedCreatorOfTerminal(launched.handle)).toBe('phone-1')
  })

  it('a new workspace’s setup terminal is the client’s', async () => {
    const runtime = pairedRuntime()
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
})
