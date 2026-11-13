import XCTest
@testable import OrcaComputerUseMacOSCore

final class TextInsertionReadbackTests: XCTestCase {

    func testInsertionReplacesTheSelectionInUTF16Offsets() {
        XCTAssertEqual(
            TextInsertionReadback.expectedValue(current: "a😀bcd", selection: 3..<5, inserting: "XY"),
            "a😀XYd"
        )
    }

    func testUnpredictableInsertionsReturnNil() {
        XCTAssertNil(TextInsertionReadback.expectedValue(current: "abc", selection: nil, inserting: "d"))
        XCTAssertNil(TextInsertionReadback.expectedValue(current: "abc", selection: 2..<4, inserting: "d"))
        XCTAssertNil(TextInsertionReadback.expectedValue(current: "a😀", selection: 2..<2, inserting: "d"))
        XCTAssertNil(TextInsertionReadback.expectedValue(current: "", selection: 0..<0, inserting: "send\n"))
        XCTAssertNil(TextInsertionReadback.expectedValue(current: "hello", selection: 0..<5, inserting: "hello"))
    }

    func testFieldStillFillingPastTheQuietWindowLands() {
        // One character every 0.4 s: each read is past the first 0.5 s window, but each change restarts it.
        let reads = ["", "h", "he", "hel", "hell", "hello"]
        XCTAssertEqual(settle(expected: "hello", reads: reads, secondsPerRead: 0.4), .landed)
    }

    func testSlowFirstReadStillGetsAQuietWindow() {
        var clock = 0.0
        var reads = ["h", "hello"][...]
        let outcome = TextInsertionReadback.settle(
            expected: "hello",
            now: { clock },
            sleep: { clock += $0 },
            read: {
                if reads.count == 2 { clock += 0.6 }
                return reads.popFirst()
            }
        )
        XCTAssertEqual(outcome, .landed)
    }

    func testReadBlockedPastTheCapIsUndetermined() {
        var clock = 0.0
        var reads = ["h", "h"][...]
        let outcome = TextInsertionReadback.settle(
            expected: "hello",
            now: { clock },
            sleep: { clock += $0 },
            read: {
                if reads.count == 1 { clock = 2.2 }
                return reads.popFirst()
            }
        )
        XCTAssertEqual(outcome, .undetermined)
    }

    func testContentEditableNoBreakSpacesLand() {
        XCTAssertEqual(settle(expected: "a  b ", reads: ["a \u{00A0}b\u{00A0}"], secondsPerRead: 0.025), .landed)
    }

    func testFieldThatDropsTheTextIsAMismatch() {
        XCTAssertEqual(settle(expected: "hello", reads: Array(repeating: "", count: 100), secondsPerRead: 0.025), .mismatch)
    }

    func testFieldThatStopsAnsweringIsUndetermined() {
        XCTAssertEqual(settle(expected: "hello", reads: ["", "h"], secondsPerRead: 0.025), .undetermined)
    }

    private func settle(expected: String, reads: [String], secondsPerRead: Double) -> TextInsertionReadback.Outcome {
        var clock = 0.0
        var remaining = reads[...]
        return TextInsertionReadback.settle(
            expected: expected,
            now: { clock },
            sleep: { _ in clock += secondsPerRead },
            read: { remaining.popFirst() }
        )
    }
}
