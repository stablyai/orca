import XCTest
@testable import OrcaComputerUseMacOSCore

final class AccessibilityTextWriteTests: XCTestCase {
    func testSuccessfulMutationWithStaleOrMissingReadDoesNotPermitFallback() {
        for actual: String? in ["old value", nil, "requested"] {
            var value = "old value"
            var writes = 0
            let outcome = AccessibilityTextWrite.perform(
                write: { writes += 1; value = "requested"; return true },
                read: { actual }
            )
            if outcome == .notWritten { value += "fallback input" }
            XCTAssertEqual(value, "requested")
            XCTAssertEqual(writes, 1)
            XCTAssertEqual(outcome, .written(actual: actual))
        }
    }

    func testRejectedWriteAllowsFallbackWithoutReadback() {
        var reads = 0
        let outcome = AccessibilityTextWrite.perform(
            write: { false },
            read: { reads += 1; return "old value" }
        )
        XCTAssertEqual(outcome, .notWritten)
        XCTAssertEqual(reads, 0)
    }
}
