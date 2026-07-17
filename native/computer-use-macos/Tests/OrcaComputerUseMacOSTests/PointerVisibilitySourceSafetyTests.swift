import XCTest

final class PointerVisibilitySourceSafetyTests: XCTestCase {
    func testPointerVisibilityDoesNotBroadenInputDelivery() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let executableSources = packageRoot
            .appendingPathComponent("Sources")
            .appendingPathComponent("OrcaComputerUseMacOS")
        let pointerSource = try String(
            contentsOf: executableSources.appendingPathComponent("AgentPointerOverlay.swift"),
            encoding: .utf8
        )

        // Why: the global cursor should show intent, but click delivery must
        // remain scoped to the selected app when focus changes unexpectedly.
        XCTAssertFalse(pointerSource.contains("CGWarpMouseCursorPosition"))
        XCTAssertTrue(pointerSource.contains("panel.ignoresMouseEvents = true"))
        XCTAssertTrue(pointerSource.contains("panel.sharingType = .none"))

        let mainSource = try String(
            contentsOf: executableSources.appendingPathComponent("main.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(mainSource.contains("event.postToPid(pid)"))
    }
}
