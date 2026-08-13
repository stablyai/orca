/**
 * STA-3077 step P: an SSH pane's durable binding must live in ONE partition.
 *
 * Today it lives in two. Main's spawn writes `ssh:<target>`
 * (ipc/pty.ts persistPtyBinding(binding, toSshExecutionHostId(connectionId))),
 * the relay's reattach write passes no hostId and lands in `local`
 * (ssh-relay-session.ts restoreReattachedPtyRuntime), and the renderer keeps SSH
 * worktrees in `local` on purpose (buildHostIdByWorktreeId). Supersession then
 * reads a binding no live writer maintains, so it compares the arriving lease
 * against a stale pty id, bails, and leaves the predecessor live. That is the
 * reported 2 -> 19 -> 20 mechanism.
 *
 * These oracles assert cardinality and identity — one pane, one live claim, and
 * the surviving claim is the shell the pane is bound to — never which function
 * ran, so they stay valid under any single-accessor implementation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../shared/execution-host'
import { toAppSshPtyId, toRelaySshPtyId } from '../shared/ssh-pty-id'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const TARGET = 'ssh-target-1'
const SSH_PARTITION = toSshExecutionHostId(TARGET)
const WORKTREE = 'repo-1:wt-1'
const TAB = 'tab-1'
/** Must be a real layout leaf UUID — the store drops any other spelling. */
const LEAF = '3f1c9a2e-7b4d-4e1a-9c8f-2d5e6a7b8c90'

const appPtyId = (relayPtyId: string): string => toAppSshPtyId(TARGET, relayPtyId)

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

type TestStore = Awaited<ReturnType<typeof createStore>>

/** One SSH pane, bound to `relayPtyId`, as a partition stores it. */
function paneSession(relayPtyId: string) {
  const ptyId = appPtyId(relayPtyId)
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: TAB,
          ptyId,
          worktreeId: WORKTREE,
          title: 'Terminal 1',
          defaultTitle: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf' as const, leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: ptyId }
      }
    }
  }
}

/** session:set for an SSH worktree — buildHostIdByWorktreeId sends it to `local`. */
function rendererPublishesPane(store: TestStore, relayPtyId: string): void {
  store.setWorkspaceSession(paneSession(relayPtyId) as never, LOCAL_EXECUTION_HOST_ID)
}

/** A mid-session write into `ssh:<target>` — orphan adoption still targets that partition, so the
 *  one-time load fold cannot be the only thing keeping the two homes from reappearing. */
function somethingRewritesTheSshPartition(store: TestStore, relayPtyId: string): void {
  store.setWorkspaceSession(paneSession(relayPtyId) as never, SSH_PARTITION)
}

/** ssh-relay-session.ts:2504 — the reattach bind. No hostId, refuses to create. */
function relayReattachBindsPane(store: TestStore, relayPtyId: string): boolean | null {
  return store.persistPtyBinding({
    worktreeId: WORKTREE,
    tabId: TAB,
    leafId: LEAF,
    ptyId: appPtyId(relayPtyId),
    incarnationId: `inc-${relayPtyId}`,
    mayCreate: false
  })
}

/** ipc/pty.ts:6493 — the spawn's lease upsert, ahead of its binding write. */
function sshSpawnUpsertsLease(store: TestStore, relayPtyId: string): void {
  store.upsertSshRemotePtyLease({
    targetId: TARGET,
    ptyId: toRelaySshPtyId(TARGET, appPtyId(relayPtyId)),
    worktreeId: WORKTREE,
    tabId: TAB,
    leafId: LEAF,
    state: 'attached',
    lastAttachedAt: Date.now()
  })
}

function liveLeaseIdsForPane(store: TestStore): string[] {
  return store
    .getSshRemotePtyLeases(TARGET)
    .filter(
      (lease) =>
        lease.tabId === TAB &&
        lease.leafId === LEAF &&
        lease.state !== 'terminated' &&
        lease.state !== 'expired'
    )
    .map((lease) => lease.ptyId)
    .sort()
}

/** The argument text of every `callee(...)` call in a production source file. */
function callArgumentsIn(source: string, callee: string): string[] {
  const calls: string[] = []
  for (let index = source.indexOf(`${callee}(`); index !== -1; ) {
    let cursor = index + callee.length
    const start = cursor + 1
    for (let depth = 0; cursor < source.length; cursor += 1) {
      if (source[cursor] === '(') {
        depth += 1
      } else if (source[cursor] === ')' && --depth === 0) {
        break
      }
    }
    calls.push(source.slice(start, cursor))
    index = source.indexOf(`${callee}(`, cursor)
  }
  return calls
}

/** On-disk state from an earlier session: both partitions name the same shell,
 *  because main's spawn wrote `ssh:<target>` and the renderer published `local`.
 *  They diverge as soon as the relay's reattach write updates only `local`. */
function diskAfterEarlierSession(relayPtyId: string) {
  return {
    workspaceSession: paneSession(relayPtyId),
    workspaceSessionsByHostId: { [SSH_PARTITION]: paneSession(relayPtyId) }
  }
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-sta3077-partition-'))
})

describe('STA-3077 step P: one pane, one live claim across partitions', () => {
  // The pane is bound to pty-2 in `local` (the relay's reattach write put it
  // there); the SSH partition still names the predecessor pty-1. Supersession
  // reads ssh-first, sees pty-1 != pty-2, and bails — both shells stay claimed.
  it('supersedes the predecessor when the pane is bound in the local partition', async () => {
    const store = await createStore(diskAfterEarlierSession('pty-1'))
    sshSpawnUpsertsLease(store, 'pty-1')
    expect(relayReattachBindsPane(store, 'pty-2')).toBe(true)

    sshSpawnUpsertsLease(store, 'pty-2')

    expect(liveLeaseIdsForPane(store)).toEqual(['pty-2'])
  })

  // reattachKnownPtys calls this first, so a wrong winner here is what fans the
  // reconnect out over a dead id and grafts a pane the user never opened.
  it('keeps the lease the live pane binding names when healing duplicates', async () => {
    const store = await createStore(diskAfterEarlierSession('pty-1'))
    sshSpawnUpsertsLease(store, 'pty-1')
    sshSpawnUpsertsLease(store, 'pty-2')
    expect(relayReattachBindsPane(store, 'pty-2')).toBe(true)

    await store.supersedeDuplicatePaneLeases(TARGET)

    expect(liveLeaseIdsForPane(store)).toEqual(['pty-2'])
  })

  // Isolates the reader from the one-time load fold. Without this clause the fold masks the
  // partition preference — it deletes the divergent copy at boot, so restoring the ssh-first
  // hedge stays green and the reader guard ships unproven. Anything that writes `ssh:<target>`
  // after load (orphan adoption still does) would then revive the defect inside one session.
  it('supersedes the predecessor when the ssh partition is rewritten mid-session', async () => {
    const store = await createStore(diskAfterEarlierSession('pty-1'))
    sshSpawnUpsertsLease(store, 'pty-1')
    expect(relayReattachBindsPane(store, 'pty-2')).toBe(true)
    somethingRewritesTheSshPartition(store, 'pty-1')

    sshSpawnUpsertsLease(store, 'pty-2')

    expect(liveLeaseIdsForPane(store)).toEqual(['pty-2'])
  })

  // The reported growth: live claims must not scale with reconnect count.
  it('holds the live claim count flat across ten reconnects of one pane', async () => {
    const store = await createStore(diskAfterEarlierSession('pty-0'))
    sshSpawnUpsertsLease(store, 'pty-0')

    for (let reconnect = 1; reconnect <= 10; reconnect += 1) {
      expect(relayReattachBindsPane(store, `pty-${reconnect}`)).toBe(true)
      sshSpawnUpsertsLease(store, `pty-${reconnect}`)
    }

    expect(liveLeaseIdsForPane(store)).toEqual(['pty-10'])
  })
})

describe('STA-3077: a decision made from one plane only mutates that plane', () => {
  // Arbitration ranks using the desktop plane's binding. The headless plane's binding never gets a
  // vote, so deleting it here would strand a shell its owner may still be using — and that owner
  // would then have no durable record to reattach by. An explicit expiry is different: the pty is
  // gone for everyone, and that path still scrubs both.
  it('leaves the headless plane binding intact when supersession retires its lease', async () => {
    const sshSession = paneSession('pty-old') as unknown as Record<string, unknown>
    const store = await createStore({
      workspaceSession: paneSession('pty-new'),
      workspaceSessionsByHostId: { [SSH_PARTITION]: sshSession }
    })
    sshSpawnUpsertsLease(store, 'pty-old')

    // Local names pty-new, so arbitration expires pty-old without the other plane being consulted.
    sshSpawnUpsertsLease(store, 'pty-new')

    expect(liveLeaseIdsForPane(store)).toEqual(['pty-new'])
    expect(
      store.getWorkspaceSession(SSH_PARTITION).terminalLayoutsByTabId?.[TAB]?.ptyIdsByLeafId?.[LEAF]
    ).toBe(appPtyId('pty-old'))
  })
})

describe('STA-3077: a pane moved between tabs still supersedes its own predecessor', () => {
  // The reported cardinality growth, in its surviving form. A lease freezes its tabId at write
  // time. Break the pane out into a new tab and its next lease carries the NEW tab, so matching
  // siblings on tabId means the two leases for one pane never meet — the predecessor is never
  // superseded and the count grows on every reconnect, exactly as reported.
  function leaseInTab(store: TestStore, relayPtyId: string, tabId: string): void {
    store.upsertSshRemotePtyLease({
      targetId: TARGET,
      ptyId: toRelaySshPtyId(TARGET, appPtyId(relayPtyId)),
      worktreeId: WORKTREE,
      tabId,
      leafId: LEAF,
      state: 'attached',
      lastAttachedAt: Date.now()
    })
  }
  const liveForLeaf = (store: TestStore): string[] =>
    store
      .getSshRemotePtyLeases(TARGET)
      .filter((l) => l.leafId === LEAF && l.state !== 'terminated' && l.state !== 'expired')
      .map((l) => l.ptyId)
      .sort()

  it('supersedes a predecessor whose lease names the tab the pane left', async () => {
    const store = await createStore()
    leaseInTab(store, 'pty-old', TAB)

    leaseInTab(store, 'pty-new', 'tab-moved-to')

    expect(liveForLeaf(store)).toEqual(['pty-new'])
  })

  it('holds the count flat across ten reconnects that each land in a new tab', async () => {
    const store = await createStore()
    leaseInTab(store, 'pty-0', TAB)
    for (let n = 1; n <= 10; n += 1) {
      leaseInTab(store, `pty-${n}`, `tab-${n}`)
    }

    expect(liveForLeaf(store)).toEqual(['pty-10'])
  })
})

describe('STA-3077: arbitration follows the pane, not the tab it was written in', () => {
  // A lease freezes its tabId when written; `detachTerminalPaneToTab` then moves the live pane and
  // its PTY into a new tab. Looking the binding up under the frozen tab finds nothing, so the bound
  // shell loses to recency and supersession retires the pane's OWN shell in favour of a stale one.
  it('finds the binding after the pane has been moved to another tab', async () => {
    const MOVED_TAB = 'tab-moved-to'
    const store = await createStore()
    // The renderer publishes the pane in its NEW tab; the lease still names the old one.
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [WORKTREE]: [{ id: MOVED_TAB, worktreeId: WORKTREE }] },
        terminalLayoutsByTabId: {
          [MOVED_TAB]: {
            root: { type: 'leaf' as const, leafId: LEAF },
            activeLeafId: LEAF,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF]: appPtyId('pty-bound') }
          }
        }
      } as never,
      LOCAL_EXECUTION_HOST_ID
    )
    sshSpawnUpsertsLease(store, 'pty-bound')
    // A newer, unbound lease arrives for the same pane under the lease's frozen tab.
    sshSpawnUpsertsLease(store, 'pty-newer')

    await store.supersedeDuplicatePaneLeases(TARGET)

    // The bound shell must win. Keyed on the frozen tab, it is invisible and recency retires it.
    expect(liveLeaseIdsForPane(store)).toEqual(['pty-bound'])
  })
})

describe('STA-3077 step P: the desktop plane resolves from its own home', () => {
  // INVERTED. This clause used to require the two partitions to AGREE after load, which assumed
  // `ssh:<target>` was a stale spill of this plane's state. It is not — it is the headless/CLI
  // plane's own home, which that plane writes and reads deliberately (STA-3463, STA-3465). The
  // property that actually matters is narrower and stronger: what the desktop plane resolves must
  // follow `local` alone, whatever the other plane holds. Asserting agreement made a migration look
  // necessary that in fact erased another plane's live state.
  it('resolves to the local binding regardless of what the ssh partition holds', async () => {
    const store = await createStore(diskAfterEarlierSession('pty-1'))

    rendererPublishesPane(store, 'pty-1')
    expect(relayReattachBindsPane(store, 'pty-2')).toBe(true)
    // The other plane names the predecessor. It does not get a vote here — local speaking about
    // this leaf IS the desktop plane's live view, and letting the other copy outrank it is the
    // STA-3077 defect. Its binding to the loser is then scrubbed with every other reference to
    // that retired lease, so the two planes do not drift further apart.
    somethingRewritesTheSshPartition(store, 'pty-1')
    sshSpawnUpsertsLease(store, 'pty-2')

    expect(store.getWorkspaceSession().terminalLayoutsByTabId?.[TAB]?.ptyIdsByLeafId?.[LEAF]).toBe(
      appPtyId('pty-2')
    )
    expect(liveLeaseIdsForPane(store)).toEqual(['pty-2'])
  })
})

describe('STA-3077 step P: every production caller names that one home', () => {
  const summarize = (source: string): string => source.replace(/\s+/g, ' ').trim().slice(0, 90)

  // A guard that behaves correctly is not evidence that both writers reach it,
  // and the defect IS that they disagree — so pin the call sites too.
  it('has no SSH pane binding write that selects the ssh partition', () => {
    const file = 'src/main/ipc/pty.ts'
    const calls = callArgumentsIn(readFileSync(file, 'utf-8'), 'persistPtyBinding')
    expect(calls.length, `${file} no longer writes pane bindings`).toBeGreaterThan(0)

    const partitioned = calls
      .filter((call) => call.includes('toSshExecutionHostId'))
      .map((call) => `${file}: ${summarize(call)}`)

    expect(partitioned).toEqual([])
  })

  // STRENGTHENED, not relaxed. This clause used to require the relay to hold a `persistPtyBinding`
  // call of its own and merely forbid an ssh-partition argument on it. Step F removed that call:
  // the relay binds through the one `bindPaneShell` producer, which is what makes the superseded-
  // pane fence live on reattach. Requiring ZERO direct writes here is the stronger property — a
  // second bind producer is exactly the defect that let spawn and reattach disagree.
  it('has no pane binding write in the relay that bypasses the one bind producer', () => {
    const source = readFileSync('src/main/ssh/ssh-relay-session.ts', 'utf-8')

    expect(callArgumentsIn(source, 'persistPtyBinding').map(summarize)).toEqual([])
    expect(source).toContain('bindPaneShell(')
  })

  // The readers must land in the same place; one that still consults
  // `ssh:<target>` reinstates the disagreement from the other side.
  it('has no stable-pane owner reader that selects the ssh partition', () => {
    const source = readFileSync('src/main/ipc/pty.ts', 'utf-8')
    const start = source.indexOf('function resolvePersistedStablePaneOwner')
    const readers = source.slice(start, source.indexOf('type StablePaneSpawnContext'))
    expect(start, 'stable-pane owner readers moved').toBeGreaterThan(0)
    expect(readers).toContain('getWorkspaceSession(')

    const partitioned = readers
      .split('\n')
      .filter((line) => line.includes('toSshExecutionHostId'))
      .map(summarize)

    expect(partitioned).toEqual([])
  })
})
