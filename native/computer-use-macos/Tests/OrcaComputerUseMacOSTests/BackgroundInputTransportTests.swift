import CoreGraphics
import XCTest
@testable import OrcaComputerUseMacOSCore

final class BackgroundInputTransportTests: XCTestCase {
    func testTypedTextRidesTheKeyDownOnly() throws {
        let bareKeyUp = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false))
        for (text, characters) in [("🚀e\u{301}👩‍💻", ["🚀", "e\u{301}", "👩‍💻"])] {
            let events = try BackgroundInputTransport.textEvents(text)
            XCTAssertEqual(events.map { $0.type }, characters.flatMap { _ in [CGEventType.keyDown, .keyUp] })
            XCTAssertEqual(events.filter { $0.type == .keyDown }.map(unicodeString), characters)
            // Why: an unset payload reads back as the keyboard layout's translation of key code 0.
            for event in events where event.type == .keyUp {
                XCTAssertEqual(unicodeString(event), unicodeString(bareKeyUp))
            }
        }
    }

    private func unicodeString(_ event: CGEvent) -> String {
        var length = 0
        var buffer = [UniChar](repeating: 0, count: 8)
        event.keyboardGetUnicodeString(maxStringLength: buffer.count, actualStringLength: &length, unicodeString: &buffer)
        return String(utf16CodeUnits: buffer, count: length)
    }
}
