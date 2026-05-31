import XCTest
@testable import OrcaComputerUseMacOSCore

final class KeyboardInputSafetyTests: XCTestCase {
    func testSyntheticInputRequiresFocusedTargetWindow() {
        XCTAssertTrue(KeyboardInputSafety.allowsSyntheticInput(targetWindowFocused: true))
        XCTAssertFalse(KeyboardInputSafety.allowsSyntheticInput(targetWindowFocused: false))
    }
}
