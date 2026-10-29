import ApplicationServices
import Testing
@testable import OrcaComputerUseMacOSCore

@Suite("AccessibilityActionOutcome")
struct AccessibilityActionOutcomeTests {
    @Test("success is performed")
    func success() {
        #expect(AccessibilityActionOutcome.classify(.success) == .performed)
    }

    @Test("an error after the app took the call may still have run")
    func mayHaveRun() {
        // What Finder returns for AXOpen on a sidebar row while it still opens the folder (#26457).
        #expect(AccessibilityActionOutcome.classify(.attributeUnsupported) == .unconfirmed(axError: -25205))
        #expect(AccessibilityActionOutcome.classify(.cannotComplete) == .unconfirmed(axError: -25204))
        #expect(AccessibilityActionOutcome.classify(.failure) == .unconfirmed(axError: -25200))
    }

    @Test("an error that means the action never ran still fails")
    func neverRan() {
        #expect(AccessibilityActionOutcome.classify(.invalidUIElement) == .notPerformed(axError: -25202))
        #expect(AccessibilityActionOutcome.classify(.actionUnsupported) == .notPerformed(axError: -25206))
        #expect(AccessibilityActionOutcome.classify(.illegalArgument) == .notPerformed(axError: -25201))
        #expect(AccessibilityActionOutcome.classify(.apiDisabled) == .notPerformed(axError: -25211))
        #expect(AccessibilityActionOutcome.classify(.notImplemented) == .notPerformed(axError: -25208))
    }
}
