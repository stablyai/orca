import Testing
@testable import OrcaComputerUseMacOSCore

@Suite("Screen Capture permission settling")
struct ScreenCapturePermissionSettlingTests {
    @Test("initial preflight success skips fallback")
    func initialSuccess() {
        var fallbackCalls = 0
        let trusted = PermissionTrustSettling.settleWithFallback(
            finalTimeoutMs: 500,
            sleepMs: { _ in },
            probe: { true },
            fallbackProbe: {
                fallbackCalls += 1
                return true
            }
        )

        #expect(trusted)
        #expect(fallbackCalls == 0)
    }

    @Test("capture fallback can establish trust")
    func fallbackSuccess() {
        var fallbackCalls = 0
        let trusted = PermissionTrustSettling.settleWithFallback(
            initialTimeoutMs: 200,
            finalTimeoutMs: 200,
            intervalMs: 100,
            sleepMs: { _ in },
            probe: { false },
            fallbackProbe: {
                fallbackCalls += 1
                return true
            }
        )

        #expect(trusted)
        #expect(fallbackCalls == 1)
    }

    @Test("preflight is retried after fallback failure")
    func finalPreflightSuccess() {
        var probeCalls = 0
        let trusted = PermissionTrustSettling.settleWithFallback(
            initialTimeoutMs: 100,
            finalTimeoutMs: 200,
            intervalMs: 100,
            sleepMs: { _ in },
            probe: {
                probeCalls += 1
                return probeCalls == 4
            },
            fallbackProbe: { false }
        )

        #expect(trusted)
        #expect(probeCalls == 4)
    }

    @Test("persistent denial remains denied")
    func persistentDenial() {
        var fallbackCalls = 0
        let trusted = PermissionTrustSettling.settleWithFallback(
            initialTimeoutMs: 100,
            finalTimeoutMs: 100,
            intervalMs: 100,
            sleepMs: { _ in },
            probe: { false },
            fallbackProbe: {
                fallbackCalls += 1
                return false
            }
        )

        #expect(!trusted)
        #expect(fallbackCalls == 1)
    }
}
