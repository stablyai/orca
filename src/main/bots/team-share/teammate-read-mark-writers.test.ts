// Rule 6 (teammate-rules.ts), at each writer of the owner's read marks and viewer holds: a teammate's
// read leaves the owner's state as it was; the owner's own read writes it. Through the real runtime and
// handlers; the store is an in-memory one holding one unread worker workspace.
import { afterEach, expect, it, vi } from 'vitest'

// The build where main holds the phone-session hold (`ORCA_SIDEBAR_INPUTS=main`), read at import.
vi.hoisted(() => Reflect.set(globalThis, 'ORCA_SIDEBAR_INPUTS', 'main'))
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { requireSwitchedOn } from '../../runtime/construction/require-sidebar-inputs-enabled'
import { partialRuntimeStore } from '../../runtime/construction/test-context/runtime-store-partial-fixture'
import type { RpcContext } from '../../runtime/rpc/core'
import type { RpcCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import { WORKTREE_SET_METHOD } from '../../runtime/rpc/methods/workspaces/worktree-set-method'
import { WORKTREE_METHODS } from '../../runtime/rpc/methods/workspaces/worktree'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { SCOPE } from './teammate-tabs.test-support'

afterEach(() => vi.restoreAllMocks())

const OWNER: RpcCallerScope = { kind: 'runtime-paired', grants: [] }
const WORKTREE_ID = 'repo-1::/work/tree-x'

/** A host with one unread worker workspace, and what its owner-visible state reads as. */
function host() {
  const partial: Partial<WorktreeMeta> = { isUnread: true }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the writers read and write its unread mark alone.
  const meta = partial as WorktreeMeta
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the writers read the repo's id and host alone.
  const repo = { id: 'repo-1', path: '/work/repo', displayName: 'repo' } as never
  const store = partialRuntimeStore({
    getRepos: () => [repo],
    getRepo: (id) => (id === 'repo-1' ? repo : undefined),
    getWorktreeMeta: (id) => (id === WORKTREE_ID ? meta : undefined),
    getWorktreeMetaForHost: (id) => (id === WORKTREE_ID ? meta : undefined),
    setWorktreeMeta: (_target, update) => {
      Object.assign(meta, update)
      return meta
    }
  })
  const runtime = new OrcaRuntimeService(store)
  const facts = requireSwitchedOn(runtime.sidebarFacts)
  runtime['graphStatus'] = 'ready'
  vi.spyOn(runtime, 'resolveGitWorktreeSelector').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the writers read the id, repo and host alone.
    { id: WORKTREE_ID, repoId: 'repo-1', hostId: 'local', path: '/work/tree-x' } as never
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers return it unread.
  vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({} as never)
  const acknowledged: unknown[] = []
  runtime.onClientEvent((event) => {
    if (event.type === 'notificationAttentionAcknowledged') {
      acknowledged.push(event.acknowledgement)
    }
  })
  const owners = () => ({
    unread: meta.isUnread,
    held: facts.workspaceViewers.isViewing(WORKTREE_ID, null),
    acknowledged: acknowledged.length
  })
  return { runtime, facts, owners }
}

const UNTOUCHED = { unread: true, held: false, acknowledged: 0 }

const call = (
  method: { handler: (params: never, context: RpcContext) => unknown; params?: unknown },
  params: unknown,
  runtime: OrcaRuntimeService,
  callerScope: RpcCallerScope
) =>
  method.handler(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parsed by the method's own schema.
    (method.params as { parse: (raw: unknown) => never }).parse(params),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read these fields alone.
    { runtime, callerScope, clientKind: 'runtime' } as RpcContext
  )

it('clears a workspace’s unread mark and attention on worktree.set for the owner’s read alone', async () => {
  for (const [reader, after] of [
    [SCOPE, UNTOUCHED],
    [OWNER, { unread: false, held: false, acknowledged: 1 }]
  ] as const) {
    const { runtime, owners } = host()
    vi.spyOn(runtime, 'prepareWorkspaceAttentionAcknowledgement').mockResolvedValue({ reads: [] })
    const read = { worktree: `id:${WORKTREE_ID}`, isUnread: false, acknowledgeAttention: true }
    await call(WORKTREE_SET_METHOD, read, runtime, reader)
    expect(owners()).toEqual(after)
  }
})

it('clears a workspace’s unread mark on opening it for the owner’s read alone', async () => {
  const activate = WORKTREE_METHODS.find((method) => method.name === 'worktree.activate')!
  for (const [reader, after] of [
    [SCOPE, UNTOUCHED],
    [OWNER, { ...UNTOUCHED, unread: false }]
  ] as const) {
    const { runtime, owners } = host()
    const open = { worktree: `id:${WORKTREE_ID}`, navigation: 'caller', notifyClients: false }
    await call(activate, open, runtime, reader)
    expect(owners()).toEqual(after)
  }
})

it('reads and holds a workspace open for the owner’s phone alone', () => {
  const { facts, owners } = host()
  facts.readAndHoldPhoneSession(WORKTREE_ID, SCOPE)()
  expect(owners()).toEqual(UNTOUCHED)
  facts.readAndHoldPhoneSession(WORKTREE_ID, SCOPE)
  expect(owners()).toEqual(UNTOUCHED)

  facts.readAndHoldPhoneSession(WORKTREE_ID, OWNER)
  expect(owners()).toEqual({ ...UNTOUCHED, unread: false, held: true })
})

it('acknowledges attention for the owner’s read alone', () => {
  const { runtime, owners } = host()
  runtime.acknowledgeNotificationAttention({ reads: [] }, SCOPE)
  expect(owners()).toEqual(UNTOUCHED)

  runtime.acknowledgeNotificationAttention({ reads: [] }, OWNER)
  expect(owners()).toEqual({ ...UNTOUCHED, acknowledged: 1 })
})
