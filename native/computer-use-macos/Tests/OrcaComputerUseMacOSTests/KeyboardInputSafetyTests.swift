import CoreGraphics
import XCTest
@testable import OrcaComputerUseMacOSCore

final class KeyboardInputSafetyTests: XCTestCase {
    func testSyntheticInputRequiresFocusedTargetWindow() {
        let cases: [(focused: Bool, restoreWindow: Bool, expectedFailure: KeyboardInputSafety.FocusFailure?)] = [
            (focused: true, restoreWindow: false, expectedFailure: nil),
            (focused: true, restoreWindow: true, expectedFailure: nil),
            (focused: false, restoreWindow: false, expectedFailure: .targetNotFocused),
            (focused: false, restoreWindow: true, expectedFailure: .targetNotFocusedAfterRestore),
        ]

        for testCase in cases {
            XCTAssertEqual(
                KeyboardInputSafety.syntheticInputFocusFailure(
                    targetWindowFocused: testCase.focused,
                    restoreWindowRequested: testCase.restoreWindow
                ),
                testCase.expectedFailure
            )
        }
    }

    func testSyntheticUnicodeIsAttachedOnlyToKeyDown() {
        XCTAssertEqual(KeyboardInputSafety.unicodeUnitCount(forKeyDown: true), 1)
        XCTAssertEqual(KeyboardInputSafety.unicodeUnitCount(forKeyDown: false), 0)
    }

    func testConstructedKeyUpCarriesNoCharacter() {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        else {
            XCTFail("failed to create keyboard events")
            return
        }
        let unit = Array("A".utf16)[0]
        let keyUpBefore = KeyboardInputSafety.unicodeUnits(of: up)
        KeyboardInputSafety.attachCharacter(unit, keyDown: down, keyUp: up)
        XCTAssertEqual(KeyboardInputSafety.unicodeUnits(of: down), [unit])
        XCTAssertEqual(KeyboardInputSafety.unicodeUnits(of: up), keyUpBefore)
        XCTAssertFalse(KeyboardInputSafety.unicodeUnits(of: up).contains(unit))
    }
}
