import CoreFoundation
import Foundation

/// Keeps long text values and long row lists to what the window shows, with a note of what was left out.
public enum VisibleRangeTruncation {
    /// Values up to this many UTF-16 units render in full, so ordinary fields never change.
    public static let minimumTruncatedLength = 2_000

    /// Whether a value is long enough to be worth an `AXVisibleCharacterRange` read.
    public static func isLong(_ value: String) -> Bool {
        (value as NSString).length > minimumTruncatedLength
    }

    /// The part of `value` inside `visibleRange` (UTF-16 offsets into the untrimmed value, as AX reports them) behind
    /// a note that says which characters it is, or nil when the value is short, the range is unknown, or it covers everything.
    public static func visibleValue(_ value: String, visibleRange: CFRange?) -> String? {
        let full = value as NSString
        guard full.length > minimumTruncatedLength, let visibleRange, visibleRange.location >= 0, visibleRange.length >= 0 else {
            return nil
        }
        let start = min(visibleRange.location, full.length)
        // Why: clamp the length first so a huge reported length cannot overflow the addition.
        let end = start + min(visibleRange.length, full.length - start)
        guard start > 0 || end < full.length else { return nil }
        guard end > start else {
            return "[truncated to visible range: no characters visible of \(full.length)]"
        }
        // Why: AX offsets count UTF-16 units, so a range edge can fall inside an emoji or a combined character.
        let range = full.rangeOfComposedCharacterSequences(for: NSRange(location: start, length: end - start))
        return "[truncated to visible range: chars \(range.location + 1)-\(range.location + range.length) of \(full.length)] " +
            full.substring(with: range)
    }

    /// Reads the rows a list shows: the app's own `AXVisibleRows` when it is a real subset of `rows`, otherwise the
    /// rows whose frame meets the list's (`isOnScreen`), otherwise all rows; capped at `limit`.
    public static func shownRows<Row>(
        _ rows: [Row],
        appVisibleRows: [Row]?,
        isOnScreen: ((Row) -> Bool)?,
        limit: Int
    ) -> (rows: [Row], visibleCount: Int) {
        let visible: [Row]
        // Why: an app that answers AXVisibleRows with every row is not filtering, so the frames decide instead.
        if let appVisibleRows, !appVisibleRows.isEmpty, appVisibleRows.count < rows.count {
            visible = appVisibleRows
        } else if let isOnScreen {
            let onScreen = rows.filter(isOnScreen)
            visible = onScreen.isEmpty ? rows : onScreen
        } else {
            visible = rows
        }
        return (Array(visible.prefix(limit)), visible.count)
    }

    /// The line that stands in for the rows of a list that are not shown, or nil when every row is.
    public static func omittedRowsNote(totalRows: Int, visibleRows: Int, shownRows: Int) -> String? {
        let offscreen = max(0, totalRows - visibleRows)
        let pastLimit = max(0, visibleRows - shownRows)
        switch (offscreen, pastLimit) {
        case (0, 0):
            return nil
        case (_, 0):
            return "... \(offscreen) more rows offscreen (scroll to see them)"
        case (0, _):
            return "... \(pastLimit) more rows not shown (row limit)"
        default:
            return "... \(offscreen + pastLimit) more rows not shown (\(offscreen) offscreen, \(pastLimit) past the row limit)"
        }
    }
}
