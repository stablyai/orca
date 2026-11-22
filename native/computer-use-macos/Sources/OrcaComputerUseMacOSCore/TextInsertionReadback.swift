import Foundation

/// Checks that text sent as keys or a paste landed: predict the field's value, then read it back.
public enum TextInsertionReadback {
    public enum Outcome: Equatable {
        case landed
        case mismatch
        /// The field stopped answering, or was still changing when the wait ran out.
        case undetermined
    }

    /// The value a field should hold once `text` replaces its selection. `selection` is in UTF-16 offsets, as
    /// AXSelectedTextRange reports it. Nil means a readback can't prove the result: a non-empty field with no
    /// selection, a range outside the value or inside a character, text with control characters (Return or Tab
    /// can submit, end editing or move focus instead of being stored), or a value the field already holds.
    public static func expectedValue(current: String, selection: Range<Int>?, inserting text: String) -> String? {
        guard !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            return nil
        }
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
        let expected = before + text + after
        return sameText(expected, current) ? nil : expected
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
        var readback = read()
        // Why: an AX read can block for seconds; the quiet window counts from the answer, not the ask.
        var quietDeadline = now() + quietSeconds
        while let current = readback, !sameText(current, expected) {
            let time = now()
            // Why: past the cap a field may still be filling or a read may have blocked through the quiet window; calling it a mismatch invites typing the rest twice.
            guard time < start + capSeconds else {
                return .undetermined
            }
            guard time < quietDeadline else {
                return .mismatch
            }
            sleep(intervalSeconds)
            readback = read()
            if readback != current {
                quietDeadline = now() + quietSeconds
            }
        }
        return readback == nil ? .undetermined : .landed
    }

    // Why: Chromium contenteditables store typed trailing or repeated spaces as no-break spaces.
    private static func sameText(_ lhs: String, _ rhs: String) -> Bool {
        lhs.replacingOccurrences(of: "\u{00A0}", with: " ") == rhs.replacingOccurrences(of: "\u{00A0}", with: " ")
    }
}
