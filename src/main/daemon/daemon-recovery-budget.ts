/**
 * How long a transient wedge takes to drain — the Windows update-relaunch AV/disk-pressure shape
 * #8697 measured. The grace exists to adopt that daemon *with* its live sessions instead of
 * killing them, so the recovery budget has to outlast this.
 *
 * Note this is the drain estimate, not the grace #8697 shipped: its merged second commit
 * (840d3277d1d) widened WEDGED_DAEMON_GRACE_RETRIES 3 -> 11 (~20s -> ~60s) precisely to keep
 * live-session loss near zero on that path. DAEMON_RECOVERY_BUDGET_MS below deliberately sits
 * under that ~60s, because the unbounded version blew the startup PTY gate and lost the sessions
 * anyway (STA-5732) — so a wedge draining between the budget and ~60s is now replaced where
 * #8697 would have adopted it. That trade is pinned in daemon-init-wedged-daemon-grace.test.ts.
 */
export const TRANSIENT_WEDGE_DRAIN_MS = 20_000

/**
 * What one connect (+ listSessions) attempt may spend. Deliberately more generous than the 3s
 * daemon health check: this probe is the second opinion on that check's verdict, and a machine
 * loaded enough to time the check out on a live daemon would time out a probe held to the same
 * bar too — turning "could not verify" into "dead". Left to its own defaults the client instead
 * grants a fresh 5s to each of four connect/hello steps plus 30s to the request, so one probe of
 * a wedged daemon could outlast the entire recovery.
 */
export const DAEMON_RECOVERY_PROBE_MS = 8_000

/**
 * One absolute wall-clock budget for adopting-or-replacing whatever daemon already owns the
 * endpoint at startup. Every caller of the out-of-process launcher shares it — the desktop
 * startup gate, orcad, and user-initiated restart — because a wedged endpoint costs the same
 * wherever it is met.
 *
 * Both bounds matter and daemon-init-wedged-daemon-grace.test.ts pins them. Above
 * TRANSIENT_WEDGE_DRAIN_MS, with room for the probe in flight when the daemon finally answers to
 * finish its hello + listSessions rather than expire on the deadline. Below what the startup PTY
 * gate can still absorb, since the kill, fork and lease that follow run inside the same fail-open
 * cap: grace used to be a probe count with no clock at all, so it ran past that cap and the
 * sessions were lost anyway, after the user watched the app hang (STA-5732).
 *
 * Sized against that cap rather than guessed, because every second not spent here is a second a
 * daemon that would have drained gets killed instead. What still has to fit after the deadline,
 * at each stage's own hard cap: killStaleDaemon 10.5s (two identity inspections at 3s + the 3s
 * SIGTERM wait + the 1s SIGKILL confirm + the 0.5s endpoint probe), the fork's 10s readiness
 * timeout, and 5s for the adoption lease and adapter connects — those two run against a daemon
 * that has just reported ready over IPC, so they get a realistic allowance, not the client's
 * unbudgeted 4x5s. 60 - 25.5 leaves 34.5s; take 32s and keep the rest as margin.
 *
 * Outside that accounting by design: the launcher's outer-catch endpoint rescue, which only
 * runs once the replacement has already failed. Clamping it to the remainder is what turned a
 * recoverable degraded adoption into total daemon loss, so it keeps its own probe default and
 * the gate may fail open ahead of it — no worse than not rescuing, and better whenever it wins.
 */
export const DAEMON_RECOVERY_BUDGET_MS = 32_000

/** One attempt's share of the recovery budget, never reaching past the deadline. */
export function daemonRecoveryProbeTimeoutMs(recoveryDeadlineMs: number): number {
  return Math.max(1, Math.min(DAEMON_RECOVERY_PROBE_MS, recoveryDeadlineMs - Date.now()))
}
