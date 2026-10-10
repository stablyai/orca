import AppKit
import XCTest
@testable import OrcaComputerUseMacOSCore

final class ClipboardTextPasteTests: XCTestCase {
    func testDelayedReceiverCannotReadPreviousImageOrFile() throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        let image = NSPasteboardItem()
        image.setData(Data([137, 80, 78, 71]), forType: .png)
        image.setString("old text", forType: .string)
        let file = NSPasteboardItem()
        file.setString("file:///synthetic-old-attachment.png", forType: .fileURL)
        XCTAssertTrue(pasteboard.writeObjects([image, file]))

        var delivered = false
        try ClipboardTextPaste.perform("new text", pasteboard: pasteboard) {
            delivered = true
            XCTAssertEqual(pasteboard.string(forType: .string), "new text")
            XCTAssertNil(pasteboard.data(forType: .png))
        }

        XCTAssertTrue(delivered)
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertEqual(pasteboard.string(forType: .string), "new text")
        XCTAssertEqual(pasteboard.pasteboardItems?.count, 1)
        XCTAssertNil(pasteboard.data(forType: .png))
        XCTAssertNil(pasteboard.string(forType: .fileURL))
    }

    func testPartialKeyDeliveryFailureDoesNotRestoreOldImage() {
        enum DeliveryFailure: Error { case afterKeyDown }
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        pasteboard.setData(Data([1, 2, 3]), forType: .png)

        XCTAssertThrowsError(try ClipboardTextPaste.perform("new text", pasteboard: pasteboard) {
            throw DeliveryFailure.afterKeyDown
        })
        XCTAssertEqual(pasteboard.string(forType: .string), "new text")
        XCTAssertNil(pasteboard.data(forType: .png))
    }

    func testDoesNotOverwriteNewClipboardOwnerAfterDelivery() throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        pasteboard.setString("old", forType: .string)
        try ClipboardTextPaste.perform("requested", pasteboard: pasteboard) {
            pasteboard.clearContents()
            pasteboard.setString("copied by user", forType: .string)
        }
        XCTAssertEqual(pasteboard.string(forType: .string), "copied by user")
    }
}
