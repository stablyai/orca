import Testing
@testable import OrcaComputerUseMacOSCore

@Suite("ScreenCapture trust settling reuse")
struct ScreenCaptureTrustSettlingTests {
    @Test("screen-recording style probes can reuse AccessibilityTrustSettling")
    func settleReusableForScreenCapturePreflight() {
        var calls = 0
        let outcome = AccessibilityTrustSettling.settle(
            timeoutMs: 500,
            intervalMs: 100,
            sleepMs: { _ in },
            probe: {
                calls += 1
                // Simulate CGPreflightScreenCaptureAccess flipping true after warm-up.
                return calls >= 3
            }
        )
        #expect(outcome.settled == true)
        #expect(outcome.attempts == 3)
    }
}
