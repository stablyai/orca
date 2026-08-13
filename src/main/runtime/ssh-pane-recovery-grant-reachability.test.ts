/**
 * Characterisation oracle for the 30-second SSH pane recovery grant in
 * `OrcaRuntimeService.recoverTerminalPane`.
 *
 * The grant is the branch that, for a DISCONNECTED pane backed by a recently
 * expired SSH lease, calls `createTerminal` to spawn a replacement shell. This
 * file does not argue that the grant is wrong; it RECORDS that the branch is
 * already dead at the id shapes production mints, so that deleting it is
 * provably inert rather than assumed to be. Test 1 is written to survive that
 * deletion unchanged: `terminal_not_recoverable` is the answer both before and
 * after, and the anti-vacuity assertions pin that control genuinely reaches the
 * grant gate instead of bailing out earlier.
 *
 * Why the branch is dead: the gate compares `pty.ptyId` (runtime, APP form —
 * `SshPtyProvider` hands ids back through `toAppSshPtyId`, and that is the id
 * `ipc/pty.ts` passes to `runtime.registerPty`) against `lease.ptyId` (durable,
 * RELAY-native — `persistence.ts` normalizes every stored lease through
 * `toRelaySshPtyId`). The comparison at `getRecentExpiredSshLease` is a raw
 * `===` with no namespace normalization, so the two strings can never be equal.
 *
 * Honest limit on the claim. For an SSH pane the refusal is unreachable BY
 * CONSTRUCTION: an app-form id always carries the `ssh:<conn>@@` prefix that
 * the relay-native lease id, by definition, does not. For a LOCAL pane the
 * argument is weaker — a local pty id is not namespaced, so the gate is
 * unreachable only up to a random-UUID string collision with a stored lease id
 * that also matches the worktree, tab and leaf. That is not a construction
 * proof, just an astronomically unlikely one. Do not overclaim it.
 */
import { describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import { OrcaRuntimeService } from './orca-runtime'

const CONNECTION_ID = 'ssh-target-1'
const RELAY_PTY_ID = 'pty-7'
// Both id forms come from the production helpers so this oracle tracks the real
// namespace split rather than restating it as two hand-typed literals.
const APP_PTY_ID = toAppSshPtyId(CONNECTION_ID, RELAY_PTY_ID)
const STORED_LEASE_PTY_ID = toRelaySshPtyId(CONNECTION_ID, APP_PTY_ID)

const REPO_ID = 'repo-1'
const WORKTREE_PATH = '/tmp/orca-grant-reachability'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const TAB_ID = 'tab-grant'
// Persistence drops any leafId that is not a terminal leaf UUID, and the gate
// compares it, so the lease only qualifies with a real one.
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

function createStore() {
  const now = Date.now()
  return {
    getRepo: (id: string) => createStore.repos.find((repo) => repo.id === id),
    getRepos: () => createStore.repos,
    getAllWorktreeMeta: () => ({
      [WORKTREE_ID]: {
        displayName: 'grant',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        linkedGitLabMR: null,
        linkedGitLabIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0
      }
    }),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => [],
    getSparsePresets: () => [],
    // Seeded to qualify on EVERY predicate of getRecentExpiredSshLease except
    // the ptyId comparison: expired, same worktree/tab/leaf, inside the grace.
    getSshRemotePtyLeases: () => [
      {
        targetId: CONNECTION_ID,
        ptyId: STORED_LEASE_PTY_ID,
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        leafId: LEAF_ID,
        state: 'expired' as const,
        createdAt: now,
        updatedAt: now
      }
    ]
  }
}
createStore.repos = [
  { id: REPO_ID, path: WORKTREE_PATH, displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
]

/** Register one SSH-owned pty under `runtimePtyId`, then kill its shell. */
function createDisconnectedPane(runtimePtyId: string) {
  const runtime = new OrcaRuntimeService(createStore() as never)
  runtime.registerPty(runtimePtyId, WORKTREE_ID, CONNECTION_ID, {
    tabId: TAB_ID,
    leafId: LEAF_ID
  })
  const handle = runtime.resolveTerminalPane(PANE_KEY, WORKTREE_ID).handle
  runtime.onPtyExit(runtimePtyId, -1)
  return { runtime, handle }
}

describe('SSH pane recovery grant reachability', () => {
  it('refuses a pane whose SSH shell died, at the id shapes production actually mints', async () => {
    // The split itself, named: the durable lease id and the runtime pty id for
    // the SAME shell are different strings.
    expect(STORED_LEASE_PTY_ID).not.toBe(APP_PTY_ID)

    const { runtime, handle } = createDisconnectedPane(APP_PTY_ID)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    // Anti-vacuity: control must actually arrive at the grant gate. A truthy
    // handle rules out an early `terminal_not_found`; connected === false rules
    // out the still-connected branch that also throws not_recoverable.
    expect(handle).toBeTruthy()
    expect(runtime.resolveTerminalPane(PANE_KEY, WORKTREE_ID).connected).toBe(false)

    await expect(runtime.recoverTerminalPane(PANE_KEY, WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  // INVERTED BY THE DELETION, and that inversion is the point.
  //
  // Before the grant was removed, this case RESOLVED with a replacement: the same seeded lease,
  // with the runtime pty registered under the bare relay id instead of the app-form one, opened
  // the gate. That is what made the case above attributable to the namespace and to nothing else —
  // the lease qualified on state, worktree, tab, leaf and grace window, and only the id comparison
  // stood between it and a spawn.
  //
  // The shape was never reachable in production (a lease implies a truthy connectionId, which
  // implies an app-form id), so flipping it to a refusal changes no real behaviour — which is
  // exactly what "the deletion is inert" means. Kept rather than dropped so the counterfactual
  // stays on record: no id shape authorizes a spawn now, not merely the one production mints.
  it('refuses even the id shape that used to open the grant', async () => {
    const { runtime, handle } = createDisconnectedPane(RELAY_PTY_ID)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    expect(handle).toBeTruthy()
    expect(runtime.resolveTerminalPane(PANE_KEY, WORKTREE_ID).connected).toBe(false)

    await expect(runtime.recoverTerminalPane(PANE_KEY, WORKTREE_ID, handle)).rejects.toThrow(
      'terminal_not_recoverable'
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })
})
