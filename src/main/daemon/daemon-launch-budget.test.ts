import { describe, expect, it } from 'vitest'
import { LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS } from '../startup/first-window-startup-services'
import {
  CLASSIFICATION_EVIDENCE_MIN_MS,
  WEDGED_DAEMON_CLASSIFICATION_BUDGET_MS
} from './daemon-init'
import { OCCUPANCY_CONNECT_BUDGET_MS, OCCUPANCY_REQUEST_BUDGET_MS } from './daemon-occupancy'
import {
  POSIX_OWNERSHIP_PROBE_DEADLINE_MS,
  PTY_OWNERSHIP_PROBE_ATTEMPTS
} from './daemon-live-pty-evidence'
import { HEALTH_CHECK_TIMEOUT_MS, PS_IDENTITY_TIMEOUT_MS } from './daemon-health'

/**
 * Kept out of the launcher's own spec because that file mocks daemon-health, which would
 * shadow constants this is here to hold to account.
 *
 * This deliberately asserts one enforced ceiling rather than a sum of the path's parts. The
 * sum was the earlier design, and four separate reviews each found a different term missing
 * from it — the launcher's own adoption connect, an identity probe, an endpoint probe, an
 * evidence deadline applied twice. Every one of them passed this file while the real path
 * overran. The launcher now spends against a clock, so the only thing left worth asserting
 * is that the clock leaves room for what comes after it.
 */
describe('wedged-daemon classification budget', () => {
  it('leaves the kill ladder and the daemon fork room under the startup fail-open', () => {
    // Startup abandons the daemon provider entirely at the cap, and ensureRunning() is not
    // abortable — so overrunning costs the app its daemon *and* still kills the incumbent.
    // What follows a replace verdict is the kill ladder (~11.5s: identity, endpoint probe,
    // KILL_WAIT, recheck, another probe, SIGKILL confirm) and the fork's own 10s readiness
    // timeout — plus, on packaged Windows, a daemon-host directory copy of unbounded size.
    // The margin above 21.5s is what covers that copy.
    const afterClassificationMs =
      LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS - WEDGED_DAEMON_CLASSIFICATION_BUDGET_MS

    expect(WEDGED_DAEMON_CLASSIFICATION_BUDGET_MS).toBeLessThan(
      LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS
    )
    expect(afterClassificationMs).toBeGreaterThanOrEqual(22_000)
  })

  it('leaves the evidence read enough clock to be worth attempting', () => {
    // Not a reservation: the probes spend first and this is checked afterwards. Assert only
    // that the threshold covers what the two steps actually cost, or the launcher would start
    // a read it cannot finish.
    const evidenceMs = POSIX_OWNERSHIP_PROBE_DEADLINE_MS * PTY_OWNERSHIP_PROBE_ATTEMPTS

    if (process.platform === 'win32') {
      // Neither guarded step runs on Windows — there is no session-leader signal to read.
      expect(CLASSIFICATION_EVIDENCE_MIN_MS).toBe(0)
    } else {
      expect(CLASSIFICATION_EVIDENCE_MIN_MS).toBeGreaterThanOrEqual(
        PS_IDENTITY_TIMEOUT_MS + evidenceMs
      )
    }
  })

  it('only attempts the evidence read while the clock can still finish it', () => {
    // The gate is what keeps an opportunistic read from becoming an overrun: the read costs an
    // identity ps plus two ownership probes, and it runs after the probes have already spent
    // whatever they spent. If the threshold ever drops below that cost, a read started near the
    // ceiling finishes past it — and the ceiling is what the kill ladder and fork are sized
    // against.
    const evidenceCostMs =
      PS_IDENTITY_TIMEOUT_MS + POSIX_OWNERSHIP_PROBE_DEADLINE_MS * PTY_OWNERSHIP_PROBE_ATTEMPTS

    if (process.platform !== 'win32') {
      expect(CLASSIFICATION_EVIDENCE_MIN_MS).toBeGreaterThanOrEqual(evidenceCostMs)
    }
    // And the ceiling must still hold if a read starts at the very last moment the gate allows.
    expect(WEDGED_DAEMON_CLASSIFICATION_BUDGET_MS).toBeGreaterThanOrEqual(
      CLASSIFICATION_EVIDENCE_MIN_MS
    )
  })

  it('gives the patient ask more clock than the cheap ask it replaced', () => {
    // Kept as arithmetic, but it is NOT the guard: this restates the expression rather than
    // executing it, so it cannot catch the expression being replaced. daemon-init.test.ts
    // 'spends a patient connect budget on the wedged ask' watches the launcher actually spend
    // it, and is the test that fails when this collapses back to the cheap constant.
    const elapsedBeforeAsk = OCCUPANCY_CONNECT_BUDGET_MS + HEALTH_CHECK_TIMEOUT_MS
    const probeBudgetMs = WEDGED_DAEMON_CLASSIFICATION_BUDGET_MS - elapsedBeforeAsk
    const patientConnectMs = Math.max(
      OCCUPANCY_CONNECT_BUDGET_MS,
      probeBudgetMs - OCCUPANCY_REQUEST_BUDGET_MS
    )

    expect(patientConnectMs).toBeGreaterThan(OCCUPANCY_CONNECT_BUDGET_MS)
  })
})
