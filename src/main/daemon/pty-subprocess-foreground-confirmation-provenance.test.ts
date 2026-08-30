/* The confirmation scan's provenance. Everything below the `ps` fork is real: the shared
 * process-table snapshot cache (its TTL, its dedupe and its scan-start stamps), the agent
 * resolver that reads it, and the tracker that keeps or retires the pane's identity. Only the
 * OS scan itself is substituted, so the orderings under test are the ones production has. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => {
  const mock = vi.fn()
  // promisify() runs while the snapshot module is evaluated — before this file's body — so the
  // custom hook has to be attached here, or the reader awaits a bare stdout instead of
  // `{ stdout }` and every scan resolves to undefined.
  Object.defineProperty(mock, Symbol.for('nodejs.util.promisify.custom'), {
    value: mock,
    configurable: true,
    writable: true
  })
  return { execFileMock: mock }
})

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { createPtyForegroundProcessTracker } from './pty-subprocess/foreground-process-tracker'
import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import type * as pty from 'node-pty'

const SHELL_PID = 4242
const SHELL_PATH = '/bin/zsh'
// Why not 0: the refresh throttle compares `Date.now()` against a `lastRefreshStartedAt` that
// initialises to 0, so a clock parked at the epoch throttles away the pane's first scan.
const BASE = 1_700_000_000_000

/** `ps -axo pid=,ppid=,stat=,command=` rows for a pane with no agent under its shell. */
function agentFreeTable(): string {
  return `${SHELL_PID} 1 Ss+ ${SHELL_PATH}\n`
}

type Deferred = { resolve: (stdout: string) => void }

/** Queues one controllable `ps` answer per scan, so a scan can be held open across other work. */
function queueScans(): { next: () => Deferred; settleAll: (stdout: string) => Promise<void> } {
  const pending: Deferred[] = []
  execFileMock.mockImplementation(
    () =>
      new Promise<{ stdout: string }>((resolvePromise) => {
        pending.push({ resolve: (stdout) => resolvePromise({ stdout }) })
      })
  )
  return {
    next: () => {
      const deferred = pending.shift()
      if (!deferred) {
        throw new Error('no ps scan was started')
      }
      return deferred
    },
    settleAll: async (stdout) => {
      // Flush first: the scan is only registered once the resolver's own awaits have run.
      await flush()
      while (pending.length > 0) {
        pending.shift()!.resolve(stdout)
        await flush()
      }
    }
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
  }
}

function trackerFor(ptyTitle: {
  value: string
}): ReturnType<typeof createPtyForegroundProcessTracker> {
  const fakePty = {
    pid: SHELL_PID,
    get process() {
      return ptyTitle.value
    }
  } as unknown as pty.IPty
  return createPtyForegroundProcessTracker({
    process: fakePty,
    shellPath: SHELL_PATH,
    sessionId: 'wt-1::/repo@@abc',
    startupAgentRecognition: null,
    isDead: () => false
  })
}

describe('a confirmation scan that resolves after an agent was recognized', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE)
    resetProcessTableSnapshotForTests()
    execFileMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetProcessTableSnapshotForTests()
  })

  it('does not retire the newer live-agent identity it never had a chance to see', async () => {
    const title = { value: 'zsh' }
    const tracker = trackerFor(title)
    const scans = queueScans()

    // A settled, agent-free scan first: this is what later gives a shell-shaped title the
    // corroboration it needs, and it is only safe while no newer agent evidence outranks it.
    vi.setSystemTime(BASE)
    tracker.observeForegroundProcess()
    await scans.settleAll(agentFreeTable())

    // The confirmation scan starts here, and its process table is sampled now.
    vi.setSystemTime(BASE + 10)
    const confirmation = tracker.confirmForegroundProcess()
    await flush()
    const confirmationScan = scans.next()

    // While it is out, the agent starts and the pty title names it. The synchronous fast path
    // stamps it without a scan, so this identity is strictly newer than the table above.
    vi.setSystemTime(BASE + 20)
    title.value = 'claude'
    expect(tracker.observeForegroundProcess().processName).toBe('claude')

    // Only now does the older scan answer, reporting a table taken before the agent existed.
    vi.setSystemTime(BASE + 25)
    title.value = 'zsh'
    confirmationScan.resolve(agentFreeTable())
    await confirmation
    await flush()

    // Inside the identity's 1s TTL the cache answers directly, so this reads whether the
    // confirmation retired it at all.
    vi.setSystemTime(BASE + 100)
    expect(tracker.observeForegroundProcess().processName).toBe('claude')

    // Past the TTL the fast path can no longer answer, which is where the retirement's real
    // cost lands: whether a shell-shaped title now counts as corroborated exit evidence.
    vi.setSystemTime(BASE + 1_500)
    const observation = tracker.observeForegroundProcess()

    expect(
      observation.evidence.verdict,
      'a scan that sampled the table before the agent started cannot report it gone'
    ).toBe('unverifiable')
  })

  /** The caller's own clock is not the table's. A fresh scan is queued behind whatever is
   *  already running, so an agent can be stamped after this call was made and still be older
   *  than the process table the answer is built from — in which case the scan really did look
   *  for it. Ordering on the request time instead would hold a dead agent name forever. */
  it("retires an identity the scan's own table was late enough to have seen", async () => {
    const title = { value: 'zsh' }
    const tracker = trackerFor(title)
    const scans = queueScans()

    vi.setSystemTime(BASE)
    tracker.observeForegroundProcess()
    await scans.settleAll(agentFreeTable())

    // The confirmation is requested here, but its scan has not started yet.
    vi.setSystemTime(BASE + 50)
    const confirmation = tracker.confirmForegroundProcess()

    // The agent is stamped after the request...
    vi.setSystemTime(BASE + 60)
    title.value = 'claude'
    expect(tracker.observeForegroundProcess().processName).toBe('claude')

    // ...but before the queued scan actually samples the table, so that table did see the pane
    // as it is now and its silence about an agent is a real observation.
    vi.setSystemTime(BASE + 70)
    title.value = 'zsh'
    await scans.settleAll(agentFreeTable())
    await confirmation
    await flush()

    // Inside the TTL, so a surviving identity would answer here: it must not.
    vi.setSystemTime(BASE + 100)
    expect(tracker.observeForegroundProcess().processName).toBe('zsh')
  })

  it('still retires an identity a later scan really did look for', async () => {
    const title = { value: 'claude' }
    const tracker = trackerFor(title)
    const scans = queueScans()

    // The agent is recognized first...
    vi.setSystemTime(BASE)
    expect(tracker.observeForegroundProcess().processName).toBe('claude')

    // ...and the confirmation scan starts strictly after it, so its table did see the pane
    // as the agent left it. This answer is entitled to retire the identity.
    vi.setSystemTime(BASE + 50)
    title.value = 'zsh'
    const confirmation = tracker.confirmForegroundProcess()
    await flush()
    await scans.settleAll(agentFreeTable())
    await confirmation
    await flush()

    // Inside the TTL the cached identity would still answer if it had been kept.
    vi.setSystemTime(BASE + 100)

    expect(tracker.observeForegroundProcess().processName).toBe('zsh')
  })
})
