import AppKit

public enum ClipboardTextPaste {
    public enum Failure: Error {
        case textWriteFailed
    }

    public static func perform(_ text: String, pasteboard: NSPasteboard, sendPaste: () throws -> Void) throws {
        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            throw Failure.textWriteFailed
        }
        // The receiver may read after key delivery returns; restoring old items can paste unrelated files.
        try sendPaste()
    }
}
