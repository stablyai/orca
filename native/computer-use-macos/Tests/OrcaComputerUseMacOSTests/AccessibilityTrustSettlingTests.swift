import Testing
@testable import OrcaComputerUseMacOSCore

@Suite("AccessibilityTrustSettling")
struct AccessibilityTrustSettlingTests {
    @Test("already-trusted probe returns immediately with zero waiting")
    func immediateSuccess() {
        var sleeps: [Int] = []
        let outcome = AccessibilityTrustSettling.settle(
            timeoutMs: 1500,
            intervalMs: 100,
            sleepMs: { sleeps.append($0) },
            probe: { true }
        )
        #expect(outcome == .init(settled: true, attempts: 1, waitedMs: 0))
        #expect(sleeps.isEmpty)
    }

    @Test("probe that turns true after a few denials settles with the elapsed wait")
    func lateGrant() {
        var calls = 0
        var sleeps: [Int] = []
        let outcome = AccessibilityTrustSettling.settle(
            timeoutMs: 1500,
            intervalMs: 100,
            sleepMs: { sleeps.append($0) },
            probe: {
                calls += 1
                return calls >= 4
            }
        )
        #expect(outcome == .init(settled: true, attempts: 4, waitedMs: 300))
        #expect(sleeps == [100, 100, 100])
    }

    @Test("probe that never turns true stops at the timeout")
    func neverGranted() {
        let outcome = AccessibilityTrustSettling.settle(
            timeoutMs: 1000,
            intervalMs: 300,
            sleepMs: { _ in },
            probe: { false }
        )
        #expect(outcome.settled == false)
        #expect(outcome.waitedMs == 1000)
        // 4 sleeps (300+300+300+100 clamped) plus the final probe after the last wait.
        #expect(outcome.attempts == 5)
    }

    @Test("final interval is clamped so total wait never exceeds the timeout")
    func clampsFinalInterval() {
        var sleeps: [Int] = []
        let outcome = AccessibilityTrustSettling.settle(
            timeoutMs: 250,
            intervalMs: 100,
            sleepMs: { sleeps.append($0) },
            probe: { false }
        )
        #expect(sleeps == [100, 100, 50])
        #expect(outcome.waitedMs == 250)
    }
}
