import Testing
@testable import OrcaComputerUseMacOSCore

@Suite("PermissionTrustSettling")
struct PermissionTrustSettlingTests {
    @Test("already-trusted probe returns immediately")
    func immediateSuccess() {
        var sleeps: [Int] = []
        let outcome = PermissionTrustSettling.settle(
            sleepMs: { sleeps.append($0) },
            probe: { true }
        )

        #expect(outcome == .init(settled: true, attempts: 1, waitedMs: 0))
        #expect(sleeps.isEmpty)
    }

    @Test("transient denial settles after retries")
    func lateGrant() {
        var calls = 0
        var sleeps: [Int] = []
        let outcome = PermissionTrustSettling.settle(
            sleepMs: { sleeps.append($0) },
            probe: {
                calls += 1
                return calls >= 4
            }
        )

        #expect(outcome == .init(settled: true, attempts: 4, waitedMs: 300))
        #expect(sleeps == [100, 100, 100])
    }

    @Test("persistent denial stops at the timeout")
    func neverGranted() {
        let outcome = PermissionTrustSettling.settle(
            timeoutMs: 1_000,
            intervalMs: 300,
            sleepMs: { _ in },
            probe: { false }
        )

        #expect(outcome == .init(settled: false, attempts: 5, waitedMs: 1_000))
    }

    @Test("final interval is clamped to the timeout")
    func clampsFinalInterval() {
        var sleeps: [Int] = []
        let outcome = PermissionTrustSettling.settle(
            timeoutMs: 250,
            intervalMs: 100,
            sleepMs: { sleeps.append($0) },
            probe: { false }
        )

        #expect(sleeps == [100, 100, 50])
        #expect(outcome == .init(settled: false, attempts: 4, waitedMs: 250))
    }
}
