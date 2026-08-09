/**
 * STA-3077 behavioral oracles: reconnecting an SSH workspace must not add panes
 * the user never opened, and must not accumulate remote shells.
 *
 * These assert observable behavior, not a mechanism, so they stay valid under
 * any implementation that fixes the defect. Each case names the root cause it
 * pins from the #12264 diagnosis.
 *
 * Reported symptom: relay PTY count went 2 -> 19 -> 20 across three reconnects.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../shared/constants'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const TARGET = 'ssh-target-1'
const WORKTREE = 'repo-1:wt-1'
const TAB = 'tab-1'
/** Must be a real layout leaf UUID — the store drops any other spelling. */
const LEAF = '3f1c9a2e-7b4d-4e1a-9c8f-2d5e6a7b8c90'

async function createStore(state: Record<string, unknown> = {}) {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({ ...getDefaultPersistedState(testState.dir), ...state }),
    'utf-8'
  )
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-sta3077-'))
})

/** One pane's lease, as the reattach path records it. */
function leaseFor(ptyId: string, updatedAt: number) {
  return {
    targetId: TARGET,
    ptyId,
    worktreeId: WORKTREE,
    tabId: TAB,
    leafId: LEAF,
    state: 'attached' as const,
    updatedAt
  }
}

function liveLeasesForPane(store: {
  getSshRemotePtyLeases: (targetId?: string) => readonly {
    ptyId: string
    tabId?: string
    leafId?: string
    state: string
  }[]
}) {
  return store
    .getSshRemotePtyLeases(TARGET)
    .filter(
      (lease) =>
        lease.tabId === TAB &&
        lease.leafId === LEAF &&
        lease.state !== 'terminated' &&
        lease.state !== 'expired'
    )
}

describe('STA-3077: one pane owns at most one live remote PTY lease', () => {
  // RC1: lease uniqueness keys on (targetId, ptyId) only, so a pane whose PTY id
  // changes leaves its predecessor behind with nothing to retire it.
  it('does not accumulate a second live lease when one pane re-leases a new PTY id', async () => {
    const store = await createStore()

    store.upsertSshRemotePtyLease(leaseFor('relay-pty-a', 1))
    store.upsertSshRemotePtyLease(leaseFor('relay-pty-b', 2))

    expect(liveLeasesForPane(store)).toHaveLength(1)
  })

  // RC1: the reported 2 -> 19 -> 20 growth. Lease count must not scale with
  // reconnect count for a fixed set of panes.
  it('keeps live lease count flat across repeated reconnects of one pane', async () => {
    const store = await createStore()

    for (let reconnect = 0; reconnect < 10; reconnect += 1) {
      store.upsertSshRemotePtyLease(leaseFor(`relay-pty-${reconnect}`, reconnect + 1))
    }

    expect(liveLeasesForPane(store)).toHaveLength(1)
  })
})

describe('STA-3077: superseding respects the durable pane binding', () => {
  // Spawn-shaped setup: the creating branches are intentionally allowed here.
  function bindPaneTo(store: Awaited<ReturnType<typeof createStore>>, ptyId: string) {
    store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      ptyId,
      incarnationId: `inc-${ptyId}`
    })
  }

  it('scrubs the predecessor binding when the arriving lease is the bound one', async () => {
    const store = await createStore()
    bindPaneTo(store, 'relay-pty-a')
    store.upsertSshRemotePtyLease(leaseFor('relay-pty-a', 1))
    bindPaneTo(store, 'relay-pty-b')
    store.upsertSshRemotePtyLease(leaseFor('relay-pty-b', 2))

    expect(liveLeasesForPane(store).map((lease) => lease.ptyId)).toEqual(['relay-pty-b'])
    const layout = store.getWorkspaceSession().terminalLayoutsByTabId?.[TAB]
    expect(layout?.ptyIdsByLeafId?.[LEAF]).toBe('relay-pty-b')
  })

  // Expiring the bound predecessor here would detach a live pane, so both stay
  // live and reattach arbitrates with the binding in hand.
  it('defers instead of expiring the lease the pane is bound to', async () => {
    const store = await createStore()
    bindPaneTo(store, 'relay-pty-a')
    store.upsertSshRemotePtyLease(leaseFor('relay-pty-a', 1))
    store.upsertSshRemotePtyLease(leaseFor('relay-pty-b', 2))

    expect(
      liveLeasesForPane(store)
        .map((lease) => lease.ptyId)
        .sort()
    ).toEqual(['relay-pty-a', 'relay-pty-b'])
    expect(store.getWorkspaceSession().terminalLayoutsByTabId?.[TAB]?.ptyIdsByLeafId?.[LEAF]).toBe(
      'relay-pty-a'
    )

    // Arbitration keeps the bound lease, not the newer one.
    expect(store.supersedeDuplicatePaneLeases(TARGET)).toBe(1)
    expect(liveLeasesForPane(store).map((lease) => lease.ptyId)).toEqual(['relay-pty-a'])
  })
})

describe('STA-3077: existing duplicate leases are healed, not revived', () => {
  // Installs that predate pane-keyed supersession already carry the duplicates
  // this bug accumulated. Preventing new ones does not help them.
  it('retires every stale duplicate for a pane and keeps the newest', async () => {
    const store = await createStore({
      sshRemotePtyLeases: Array.from({ length: 20 }, (_, index) => ({
        ...leaseFor(`relay-pty-${index}`, index + 1),
        createdAt: index + 1
      }))
    })

    const retired = store.supersedeDuplicatePaneLeases(TARGET)

    expect(retired).toBe(19)
    expect(liveLeasesForPane(store).map((lease) => lease.ptyId)).toEqual(['relay-pty-19'])
  })

  // Recency alone would retire the lease the pane is actually bound to whenever a
  // newer unbound lease exists, detaching a live pane instead of healing it.
  it('keeps the durably bound lease even when an unbound one is newer', async () => {
    const store = await createStore()
    store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      ptyId: 'relay-pty-bound',
      incarnationId: 'inc-bound'
    })
    store.upsertSshRemotePtyLease({ ...leaseFor('relay-pty-bound', 1), createdAt: 1 })
    // Arrives later but no pane is bound to it.
    store.upsertSshRemotePtyLease({ ...leaseFor('relay-pty-newer', 99), createdAt: 99 })

    store.supersedeDuplicatePaneLeases(TARGET)

    expect(liveLeasesForPane(store).map((lease) => lease.ptyId)).toEqual(['relay-pty-bound'])
  })

  // A retirement that is not durable must not be believed: it would read as
  // retired in memory and attached on disk for the rest of the session.
  it('rolls the retirement back when the durable write fails', async () => {
    const store = await createStore({
      sshRemotePtyLeases: [
        { ...leaseFor('relay-pty-a', 1), createdAt: 1 },
        { ...leaseFor('relay-pty-b', 2), createdAt: 2 }
      ]
    })
    vi.spyOn(store, 'flushOrThrow').mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(store.supersedeDuplicatePaneLeases(TARGET)).toBe(0)
    expect(liveLeasesForPane(store)).toHaveLength(2)
  })

  it('leaves distinct panes alone', async () => {
    const otherLeaf = '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d'
    const store = await createStore({
      sshRemotePtyLeases: [
        { ...leaseFor('relay-pty-a', 1), createdAt: 1 },
        { ...leaseFor('relay-pty-b', 2), createdAt: 2, leafId: otherLeaf }
      ]
    })

    expect(store.supersedeDuplicatePaneLeases(TARGET)).toBe(0)
    expect(store.getSshRemotePtyLeases(TARGET).filter((l) => l.state === 'attached')).toHaveLength(
      2
    )
  })
})

describe('STA-3077: reattach binds panes, it never creates them', () => {
  // RC3: persistPtyBinding has four creating branches (mint tab, mint root leaf,
  // split root and graft leaf, mint layout). They are load-bearing for spawn and
  // wrong for reattach, where the pane either exists or is gone for good.
  it('does not mint a tab for a pane that no longer exists', async () => {
    const store = await createStore()

    store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      ptyId: 'relay-pty-a',
      incarnationId: 'inc-a',
      mayCreate: false
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree?.[WORKTREE] ?? []).toHaveLength(0)
    expect(session.terminalLayoutsByTabId?.[TAB]).toBeUndefined()
  })

  // Unknown is not dead: failing to resolve a pane must not be reported as
  // success, and must not terminate anything.
  it('reports an unresolved reattach rather than silently succeeding', async () => {
    const store = await createStore()

    const bound = store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      ptyId: 'relay-pty-a',
      incarnationId: 'inc-a',
      mayCreate: false
    })

    expect(bound).toBe(false)
  })
})

describe('STA-3077: exact-binding compare-and-swap', () => {
  // Already correct at HEAD. Pinned so a fix cannot regress it: a stale renderer
  // replay must not overwrite a binding the host has since re-admitted.
  it('refuses a write whose expected binding no longer matches', async () => {
    const store = await createStore()

    const stale = store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      ptyId: 'relay-pty-b',
      incarnationId: 'inc-b',
      expectedBinding: { ptyId: 'relay-pty-a', incarnationId: 'inc-a' }
    })

    expect(stale).toBe(false)
  })
})

describe('STA-3077: the reattach path actually refuses to create', () => {
  // This is the oracle the store-level tests could not provide: `mayCreate`
  // existed and was correct, but no production caller passed it, so reattach
  // still grafted panes. Pin the wiring, not just the capability.
  // The reattach bind now goes through the one `bindPaneShell` producer, and it
  // still refuses to create.
  it('passes mayCreate:false from the SSH reattach binding write', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/main/ssh/ssh-relay-session.ts', 'utf-8')
    const bindCall = source.slice(
      source.indexOf('restoreReattachedPtyRuntime'),
      source.indexOf('private async attachPtyWithRetry')
    )
    expect(bindCall).toContain('bindPaneShell')
    expect(bindCall).toContain('mayCreate: false')
  })

  // Strengthened, not relaxed: counting guards against calls went vacuous once
  // the direct store calls disappeared, so pin both halves instead.
  it('has no production persistPtyBinding caller that can create during reattach', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/main/ssh/ssh-relay-session.ts', 'utf-8')
    // Every bind in the relay session is a reattach; none may grow topology.
    expect(source.split('persistPtyBinding(').length - 1).toBe(0)
    const binds = source.split('bindPaneShell(').length - 1
    expect(binds).toBeGreaterThan(0)
    // Each `bindPaneShell(` call site must carry its own `mayCreate: false`.
    const guardedBinds = source
      .split('bindPaneShell(')
      .slice(1)
      .filter((tail) => tail.slice(0, tail.indexOf('})')).includes('mayCreate: false')).length
    expect(guardedBinds).toBe(binds)
  })
})
