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

/** Every pty id this one pane is durably bound to, across every partition. */
function boundPtyIdsAcrossPartitions(store: TestStore): string[] {
  const partitions = [LOCAL_EXECUTION_HOST_ID, SSH_PARTITION]
  return Array.from(
    new Set(
      partitions
        .map((hostId) => store.getWorkspaceSession(hostId).terminalLayoutsByTabId?.[TAB])
        .map((layout) => layout?.ptyIdsByLeafId?.[LEAF])
        .filter((ptyId): ptyId is string => typeof ptyId === 'string')
    )
  ).sort()
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

    store.supersedeDuplicatePaneLeases(TARGET)

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

describe('STA-3077 step P: the pane binding has one home', () => {
  // Loading legacy state must fold the SSH partition's pane bindings into the
  // one partition every reader consults; two homes is the defect itself.
  it('resolves one pane to one durable pty id after loading legacy state', async () => {
    const store = await createStore(diskAfterEarlierSession('pty-1'))

    rendererPublishesPane(store, 'pty-1')
    expect(relayReattachBindsPane(store, 'pty-2')).toBe(true)

    expect(boundPtyIdsAcrossPartitions(store)).toEqual([appPtyId('pty-2')])
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
