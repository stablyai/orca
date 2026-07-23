import Foundation

/// Retries a trust/readability probe until it succeeds or a deadline passes.
///
/// Why: tccd answers a freshly spawned helper process with
/// `preflight_unknown` / `do_not_cache` for a short window after spawn, so the
/// first Accessibility answers a new process sees can be `denied` even though
/// the grant is real, flipping to `granted` moments later within the same pid
/// (stablyai/orca#9458). Every CLI invocation spawns a fresh helper, so a
/// one-shot check loses that race on every call.
public enum AccessibilityTrustSettling {
    public struct Outcome: Equatable {
        public let settled: Bool
        public let attempts: Int
        public let waitedMs: Int

        public init(settled: Bool, attempts: Int, waitedMs: Int) {
            self.settled = settled
            self.attempts = attempts
            self.waitedMs = waitedMs
        }
    }

    public static let defaultTimeoutMs = 1500
    public static let defaultIntervalMs = 100

    /// Probes immediately, then keeps probing on `intervalMs` boundaries until
    /// `probe` returns true or `timeoutMs` has been spent sleeping. The happy
    /// path (already trusted) returns after one probe with zero sleeps.
    public static func settle(
        timeoutMs: Int = defaultTimeoutMs,
        intervalMs: Int = defaultIntervalMs,
        sleepMs: (Int) -> Void = { interval in
            usleep(useconds_t(interval * 1000))
        },
        probe: () -> Bool
    ) -> Outcome {
        precondition(intervalMs > 0, "intervalMs must be positive")
        var attempts = 0
        var waitedMs = 0
        while true {
            attempts += 1
            if probe() {
                return Outcome(settled: true, attempts: attempts, waitedMs: waitedMs)
            }
            if waitedMs >= timeoutMs {
                return Outcome(settled: false, attempts: attempts, waitedMs: waitedMs)
            }
            let interval = min(intervalMs, timeoutMs - waitedMs)
            sleepMs(interval)
            waitedMs += interval
        }
    }
}
