import Foundation

/// Checks that text sent as keys or a paste landed: predict the field's value, then read it back.
public enum TextInsertionReadback {
    public enum Outcome: Equatable {
        case landed
        case mismatch
        case unreadable
    }

    /// The value a field should hold once `text` replaces its selection. `selection` is in UTF-16 offsets, as
    /// AXSelectedTextRange reports it. Nil means the result can't be predicted: a non-empty field with no
    /// selection, or a range outside the value or inside a character.
    public static func expectedValue(current: String, selection: Range<Int>?, inserting text: String) -> String? {
        let units = Array(current.utf16)
        let range: Range<Int>
        if let selection {
            guard selection.lowerBound >= 0, selection.upperBound <= units.count else {
                return nil
            }
            range = selection
        } else if units.isEmpty {
            range = 0..<0
        } else {
            return nil
        }
        let prefix = Array(units[..<range.lowerBound])
        let suffix = Array(units[range.upperBound...])
        let before = String(decoding: prefix, as: UTF16.self)
        let after = String(decoding: suffix, as: UTF16.self)
        // Why: a boundary inside a surrogate pair decodes to U+FFFD, which no real field would read back.
        guard Array(before.utf16) == prefix, Array(after.utf16) == suffix else {
            return nil
        }
        return before + text + after
    }

    /// Reads the field until it holds `expected`. Keys reach it through the app's event queue, so it can still be
    /// filling after the last key is posted: each change restarts the quiet window, up to `capSeconds` in all.
    public static func settle(
        expected: String,
        quietSeconds: Double = 0.5,
        capSeconds: Double = 2,
        intervalSeconds: Double = 0.025,
        now: () -> Double = CFAbsoluteTimeGetCurrent,
        sleep: (Double) -> Void = { Thread.sleep(forTimeInterval: $0) },
        read: () -> String?
    ) -> Outcome {
        let start = now()
        var quietDeadline = start + quietSeconds
        var readback = read()
        while let current = readback, !sameText(current, expected) {
            let time = now()
            guard time < quietDeadline, time < start + capSeconds else {
                return .mismatch
            }
            sleep(intervalSeconds)
            readback = read()
            if readback != current {
                quietDeadline = now() + quietSeconds
            }
        }
        return readback == nil ? .unreadable : .landed
    }

    // Why: Chromium contenteditables store typed trailing or repeated spaces as no-break spaces.
    private static func sameText(_ lhs: String, _ rhs: String) -> Bool {
        lhs.replacingOccurrences(of: "\u{00A0}", with: " ") == rhs.replacingOccurrences(of: "\u{00A0}", with: " ")
    }
}
