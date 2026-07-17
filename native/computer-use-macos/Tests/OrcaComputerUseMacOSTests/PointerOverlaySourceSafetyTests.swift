import XCTest

final class PointerOverlaySourceSafetyTests: XCTestCase {
    func testOverlayDoesNotUseLegacyCaptureOrNativePointerAPIs() throws {
        let pointerSource = try executableSource("AgentPointerOverlay.swift")

        XCTAssertFalse(pointerSource.contains("sharingType"))
        XCTAssertFalse(pointerSource.contains("CGWarpMouseCursorPosition"))
        XCTAssertTrue(pointerSource.contains("panel.ignoresMouseEvents = true"))
        XCTAssertTrue(pointerSource.contains(".canJoinAllApplications"))
        XCTAssertTrue(pointerSource.contains("override var canBecomeKey: Bool { false }"))
        XCTAssertTrue(pointerSource.contains("override var canBecomeMain: Bool { false }"))
    }

    func testModelCaptureAndInputDeliveryRemainTargetScoped() throws {
        let mainSource = try executableSource("main.swift")

        XCTAssertTrue(mainSource.contains("captureModelImage"))
        XCTAssertTrue(mainSource.contains("SCContentFilter(desktopIndependentWindow: window)"))
        XCTAssertTrue(mainSource.contains("[.optionIncludingWindow]"))
        XCTAssertTrue(mainSource.contains("configuration.showsCursor = false"))
        XCTAssertFalse(mainSource.contains(".post(tap:"))
        XCTAssertTrue(mainSource.contains("event.postToPid(pid)"))
    }

    private func executableSource(_ name: String) throws -> String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let path = packageRoot
            .appendingPathComponent("Sources")
            .appendingPathComponent("OrcaComputerUseMacOS")
            .appendingPathComponent(name)
        return try String(contentsOf: path, encoding: .utf8)
    }
}
