// The one test that spans both halves of the sweep. Every other test in this feature asserts on a
// hand-written `ForegroundProcessEvidence` literal, which is exactly how a foreground-only idle
// predicate survived review: the literals said `shellIsForeground: true` for an idle shell because
// that is what the author believed, and nothing ever produced one from a real process table.
//
// So this runs the REAL publisher (`resolveAgentForegroundProcessesBatch` ->
// `toForegroundProcessEvidence`, what `pty.listProcesses` calls) against the REAL client reader
// (`planRelayPtySweep`), over `ps` output captured verbatim from a Linux container driving a real
// `bash -i` on a real pty. The fixtures below are transcripts, not constructions.
//
// Read the shell's own row in each fixture. In `background` and `ctrlz` it is
// `pgid == tpgid`, `Ss+` — byte-identical to `idle`. That is the defect: a foreground-only
// predicate cannot see a job the user backgrounded or suspended, and the stop it authorizes
// SIGKILLs every process group on the tty.
import { describe, expect, it } from 'vitest'
import {
  resolveAgentForegroundProcessesBatch,
  toForegroundProcessEvidence
} from '../providers/agent-foreground-process-batch'
import { parseStrictProcessTableRows } from '../../shared/process-table-snapshot'
import {
  planRelayPtySweep,
  RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS,
  RELAY_PTY_SWEEP_MIN_AGE_MS,
  type RelayPtySweepContext
} from '../../shared/ssh-relay-pty-ownership-proof'

const OURS = 'client-instance-ours'

/** `ps -axo pid=,ppid=,pgid=,tpgid=,stat=,command=` on debian:bookworm-slim, one capture per pane
 *  state, each with a `bash -i` on a pty forked by the harness. */
const CAPTURES = {
  /** Nothing running. The only sweepable state. */
  idle: {
    rootPid: 3150,
    table: [
      '    1     0     1    -1 Ss   python3 /work/.ptycap.py',
      ' 3150     1  3150  3150 Ss+  bash -i',
      ' 3151     1     1    -1 R    ps -axo pid=,ppid=,pgid=,tpgid=,stat=,command='
    ]
  },
  /** `sleep 300` in the foreground. The shell's tpgid moved off its own pgid. */
  foreground: {
    rootPid: 3155,
    table: [
      '    1     0     1    -1 Ss   python3 /work/.ptycap.py',
      ' 3155     1  3155  3156 Ss   bash -i',
      ' 3156  3155  3156  3156 S+   sleep 300',
      ' 3157     1     1    -1 R    ps -axo pid=,ppid=,pgid=,tpgid=,stat=,command='
    ]
  },
  /** `sleep 300 &`. The shell reads IDENTICALLY to `idle`; only the job's own row differs. */
  background: {
    rootPid: 3152,
    table: [
      '    1     0     1    -1 Ss   python3 /work/.ptycap.py',
      ' 3152     1  3152  3152 Ss+  bash -i',
      ' 3153  3152  3153  3152 S    sleep 300',
      ' 3154     1     1    -1 R    ps -axo pid=,ppid=,pgid=,tpgid=,stat=,command='
    ]
  },
  /** `sleep 300` then Ctrl-Z. The shell again reads IDENTICALLY to `idle`. */
  ctrlz: {
    rootPid: 3158,
    table: [
      '    1     0     1    -1 Ss   python3 /work/.ptycap.py',
      ' 3158     1  3158  3158 Ss+  bash -i',
      ' 3159  3158  3159  3158 T    sleep 300',
      ' 3160     1     1    -1 R    ps -axo pid=,ppid=,pgid=,tpgid=,stat=,command='
    ]
  }
} as const

function context(overrides: Partial<RelayPtySweepContext> = {}): RelayPtySweepContext {
  return {
    clientInstanceId: OURS,
    isSessionOwner: true,
    routedPtyIds: new Set<string>(),
    expiredLeasePtyIds: new Set<string>(),
    minimumHostAgeMs: RELAY_PTY_SWEEP_MIN_AGE_MS,
    evidenceAgeSinceListingMs: 0,
    maximumEvidenceAgeMs: RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS,
    ...overrides
  }
}

/** Everything the host does between reading `ps` and putting a record on the wire. */
async function publish(
  capture: { rootPid: number; table: readonly string[] },
  capturedAgeMs = 0
): Promise<ReturnType<typeof toForegroundProcessEvidence>> {
  const rows = parseStrictProcessTableRows(capture.table.join('\n'))
  const [result] = await resolveAgentForegroundProcessesBatch(
    [{ rootPid: capture.rootPid, fallbackProcess: 'bash' }],
    { rows }
  )
  return toForegroundProcessEvidence(result, {
    authorityGeneration: 'relay-generation-1',
    observationEpoch: 1,
    capturedAgeMs
  })
}

/** Everything the client does with that record. Returns the plan for one orphan entry. */
async function planFor(
  capture: { rootPid: number; table: readonly string[] },
  overrides: { capturedAgeMs?: number; context?: Partial<RelayPtySweepContext> } = {}
): Promise<ReturnType<typeof planRelayPtySweep>> {
  return planRelayPtySweep(
    [
      {
        ptyId: 'pty-1',
        incarnationId: 'inc-1',
        ownerClientInstanceId: OURS,
        hostAgeMs: RELAY_PTY_SWEEP_MIN_AGE_MS * 2,
        paneBound: true,
        foregroundProcessEvidence: await publish(capture, overrides.capturedAgeMs)
      }
    ],
    context(overrides.context)
  )
}

function skipReason(plan: ReturnType<typeof planRelayPtySweep>): string | undefined {
  return plan.skipped.find((entry) => entry.ptyId === 'pty-1')?.reason
}

describe('what the host publishes about a pane, read by the sweep', () => {
  it('records that a backgrounded and a suspended shell are indistinguishable at tpgid/pgid', () => {
    // The premise of the whole file. If this ever fails, the fixtures drifted and every verdict
    // below is testing something other than the defect. Pids differ between captures, so the
    // comparison is of the shell row's shape: who its parent is, whether it leads its own process
    // group, whether that group owns the terminal, and its state flags.
    const shellShape = (capture: { rootPid: number; table: readonly string[] }): string => {
      const row = parseStrictProcessTableRows(capture.table.join('\n')).find(
        (candidate) => candidate.pid === capture.rootPid
      )!
      return [
        `ppid=${row.ppid}`,
        `leadsOwnGroup=${row.pgid === row.pid}`,
        `ownsTerminal=${row.tpgid === row.pgid}`,
        `stat=${row.stat}`
      ].join(' ')
    }

    expect(shellShape(CAPTURES.idle)).toBe('ppid=1 leadsOwnGroup=true ownsTerminal=true stat=Ss+')
    expect(shellShape(CAPTURES.background)).toBe(shellShape(CAPTURES.idle))
    expect(shellShape(CAPTURES.ctrlz)).toBe(shellShape(CAPTURES.idle))
    expect(shellShape(CAPTURES.foreground)).not.toBe(shellShape(CAPTURES.idle))
  })

  it('sweeps an idle shell', async () => {
    const evidence = await publish(CAPTURES.idle)
    expect(evidence).toMatchObject({
      verdict: 'live',
      processName: null,
      shellOwnsEveryTtyProcessGroup: true
    })

    const plan = await planFor(CAPTURES.idle)
    expect(plan.sweep).toEqual([{ ptyId: 'pty-1', incarnationId: 'inc-1' }])
  })

  it('never sweeps a pane running a foreground job', async () => {
    const evidence = await publish(CAPTURES.foreground)
    expect(evidence).toMatchObject({ shellOwnsEveryTtyProcessGroup: false })

    const plan = await planFor(CAPTURES.foreground)
    expect(plan.sweep).toEqual([])
    expect(skipReason(plan)).toBe('host does not attest an idle shell')
  })

  it('never sweeps a pane holding a backgrounded job', async () => {
    // `sleep 300 &`, i.e. `pnpm build &` or `npm run dev &`. The shell handed the terminal back,
    // so the pane looks idle; the job is alive in its own process group on the same tty and a
    // stop would SIGKILL it.
    const evidence = await publish(CAPTURES.background)
    expect(evidence).toMatchObject({ shellOwnsEveryTtyProcessGroup: false })

    const plan = await planFor(CAPTURES.background)
    expect(plan.sweep).toEqual([])
    expect(skipReason(plan)).toBe('host does not attest an idle shell')
  })

  it('never sweeps a pane holding a Ctrl-Z suspended job', async () => {
    const evidence = await publish(CAPTURES.ctrlz)
    expect(evidence).toMatchObject({ shellOwnsEveryTtyProcessGroup: false })

    const plan = await planFor(CAPTURES.ctrlz)
    expect(plan.sweep).toEqual([])
    expect(skipReason(plan)).toBe('host does not attest an idle shell')
  })

  it('refuses an observation older than the pass it would authorize', async () => {
    // Same idle capture that sweeps above; only its age differs. Staleness degrades to "leave it
    // running", never to "stop it".
    const stale = await planFor(CAPTURES.idle, {
      capturedAgeMs: RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS + 1
    })
    expect(stale.sweep).toEqual([])
    expect(skipReason(stale)).toBe('host foreground observation is too old to authorize a stop')

    // And the client's own share of the age counts: a host stamp inside the budget still ages out
    // while this pass reads leases and plans.
    const agedOnTheClient = await planFor(CAPTURES.idle, {
      capturedAgeMs: RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS,
      context: { evidenceAgeSinceListingMs: 1 }
    })
    expect(agedOnTheClient.sweep).toEqual([])
    expect(skipReason(agedOnTheClient)).toBe(
      'host foreground observation is too old to authorize a stop'
    )
  })

  it('never sweeps when the host itself is too degraded to answer', async () => {
    // `main` has since added `recoverRemoteTerminalRuntime`, a self-driven reconnect on relay
    // node-pty failure — a sweep trigger that fires exactly when the host is unwell. The publisher
    // has to fail closed there: a capture that cannot locate the shell is `unverifiable`, which is
    // its own verdict and never collapses into "idle" (docs/reference/ssh-execution-boundary.md).
    const evidence = await publish({ rootPid: 999_999, table: CAPTURES.idle.table })
    expect(evidence).toMatchObject({ verdict: 'unverifiable', reason: 'root_missing' })

    const plan = await planFor({ rootPid: 999_999, table: CAPTURES.idle.table })
    expect(plan.sweep).toEqual([])
    expect(skipReason(plan)).toBe('host could not observe the pane foreground process')
  })

  it('still reclaims a shell whose work really did finish', async () => {
    // The feature must not degrade into a no-op. The background fixture's job is gone; what is
    // left is the same orphaned shell, and it is swept.
    const finished = {
      rootPid: CAPTURES.background.rootPid,
      table: CAPTURES.background.table.filter((line) => !line.includes('sleep 300'))
    }
    const plan = await planFor(finished)
    expect(plan.sweep).toEqual([{ ptyId: 'pty-1', incarnationId: 'inc-1' }])
  })
})
