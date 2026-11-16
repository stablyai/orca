import CoreFoundation
import XCTest
@testable import OrcaComputerUseMacOSCore

final class VisibleRangeTruncationTests: XCTestCase {
    private let longValue = (1...400).map { String(format: "line %04d", $0) }.joined(separator: "\n")

    func testShortValuesStayWholeEvenWhenPartlyVisible() {
        let value = String(repeating: "a", count: VisibleRangeTruncation.minimumTruncatedLength)
        XCTAssertNil(VisibleRangeTruncation.visibleValue(value, visibleRange: CFRange(location: 0, length: 10)))
    }

    func testLongValueKeepsOnlyTheVisibleCharactersBehindANote() {
        let start = (longValue as NSString).range(of: "line 0100").location
        let visible = VisibleRangeTruncation.visibleValue(longValue, visibleRange: CFRange(location: start, length: 19))
        XCTAssertEqual(visible, "[truncated to visible range: chars \(start + 1)-\(start + 19) of 3999] line 0100\nline 0101")
    }

    func testLongValueStaysWholeWhenTheRangeIsUnknownOrCoversIt() {
        XCTAssertNil(VisibleRangeTruncation.visibleValue(longValue, visibleRange: nil))
        XCTAssertNil(VisibleRangeTruncation.visibleValue(longValue, visibleRange: CFRange(location: 0, length: 3999)))
        XCTAssertNil(VisibleRangeTruncation.visibleValue(longValue, visibleRange: CFRange(location: 0, length: 99_999)))
        XCTAssertNil(VisibleRangeTruncation.visibleValue(longValue, visibleRange: CFRange(location: -1, length: 10)))
    }

    func testHugeReportedLengthClampsInsteadOfOverflowing() {
        let visible = VisibleRangeTruncation.visibleValue(longValue, visibleRange: CFRange(location: 1, length: Int.max))
        XCTAssertEqual(visible?.hasPrefix("[truncated to visible range: chars 2-3999 of 3999] "), true)
    }

    func testEmptyVisibleRangeSaysNothingIsVisible() {
        XCTAssertEqual(
            VisibleRangeTruncation.visibleValue(longValue, visibleRange: CFRange(location: 50, length: 0)),
            "[truncated to visible range: no characters visible of 3999]"
        )
    }

    func testOffsetsCountFromTheUntrimmedValue() {
        let value = "\n\n  " + longValue
        let visible = VisibleRangeTruncation.visibleValue(value, visibleRange: CFRange(location: 4, length: 9))
        XCTAssertEqual(visible, "[truncated to visible range: chars 5-13 of 4003] line 0001")
    }

    func testRangeEdgeInsideAnEmojiWidensToTheWholeCharacter() {
        let value = String(repeating: "x", count: 2_500) + "👍" + String(repeating: "y", count: 10)
        // The emoji is two UTF-16 units at offsets 2500 and 2501; the range starts on its second half.
        let visible = VisibleRangeTruncation.visibleValue(value, visibleRange: CFRange(location: 2_501, length: 3))
        XCTAssertEqual(visible, "[truncated to visible range: chars 2501-2504 of 2512] 👍yy")
    }

    func testRowsPreferTheAppsVisibleRowsWhenTheyAreASubset() {
        var framesRead = 0
        let shown = VisibleRangeTruncation.shownRows(
            Array(0..<2_000),
            appVisibleRows: Array(40..<65),
            isOnScreen: { _ in framesRead += 1; return true },
            limit: 20
        )
        XCTAssertEqual(shown.rows, Array(40..<60))
        XCTAssertEqual(shown.visibleCount, 25)
        XCTAssertEqual(framesRead, 0)
    }

    func testRowsFallBackToFramesWhenTheAppReportsEveryRowAsVisible() {
        let shown = VisibleRangeTruncation.shownRows(
            Array(0..<100),
            appVisibleRows: Array(0..<100),
            isOnScreen: { (30..<40).contains($0) },
            limit: 20
        )
        XCTAssertEqual(shown.rows, Array(30..<40))
        XCTAssertEqual(shown.visibleCount, 10)
    }

    func testRowsWithNoFramesOnScreenKeepTheFirstRowsAsBefore() {
        let shown = VisibleRangeTruncation.shownRows(Array(0..<100), appVisibleRows: nil, isOnScreen: { _ in false }, limit: 20)
        XCTAssertEqual(shown.rows, Array(0..<20))
        XCTAssertEqual(shown.visibleCount, 100)
        let unknown = VisibleRangeTruncation.shownRows(Array(0..<5), appVisibleRows: nil, isOnScreen: nil, limit: 20)
        XCTAssertEqual(unknown.rows, Array(0..<5))
    }

    func testOmittedRowsNoteSaysWhyRowsAreMissing() {
        XCTAssertNil(VisibleRangeTruncation.omittedRowsNote(totalRows: 12, visibleRows: 12, shownRows: 12))
        XCTAssertEqual(
            VisibleRangeTruncation.omittedRowsNote(totalRows: 2_000, visibleRows: 20, shownRows: 20),
            "... 1980 more rows offscreen (scroll to see them)"
        )
        XCTAssertEqual(
            VisibleRangeTruncation.omittedRowsNote(totalRows: 30, visibleRows: 30, shownRows: 20),
            "... 10 more rows not shown (row limit)"
        )
        XCTAssertEqual(
            VisibleRangeTruncation.omittedRowsNote(totalRows: 2_000, visibleRows: 28, shownRows: 20),
            "... 1980 more rows not shown (1972 offscreen, 8 past the row limit)"
        )
    }
}
