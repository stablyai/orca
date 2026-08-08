import Foundation

public enum PermissionTrustSettling {
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

    public static let defaultTimeoutMs = 1_500
    public static let defaultIntervalMs = 100

    public static func settle(
        timeoutMs: Int = defaultTimeoutMs,
        intervalMs: Int = defaultIntervalMs,
        sleepMs: (Int) -> Void = { interval in
            Thread.sleep(forTimeInterval: TimeInterval(interval) / 1_000)
        },
        probe: () -> Bool
    ) -> Outcome {
        precondition(timeoutMs >= 0, "timeoutMs must not be negative")
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

    public static func settleWithFallback(
        initialTimeoutMs: Int = defaultTimeoutMs,
        finalTimeoutMs: Int,
        intervalMs: Int = defaultIntervalMs,
        sleepMs: (Int) -> Void = { interval in
            Thread.sleep(forTimeInterval: TimeInterval(interval) / 1_000)
        },
        probe: () -> Bool,
        fallbackProbe: () -> Bool
    ) -> Bool {
        if settle(
            timeoutMs: initialTimeoutMs,
            intervalMs: intervalMs,
            sleepMs: sleepMs,
            probe: probe
        ).settled {
            return true
        }
        if fallbackProbe() {
            return true
        }
        return settle(
            timeoutMs: finalTimeoutMs,
            intervalMs: intervalMs,
            sleepMs: sleepMs,
            probe: probe
        ).settled
    }
}
