import XCTest

final class AgentEntrypointSourceSafetyTests: XCTestCase {
    func testAgentEntrypointDoesNotUnlinkCallerSuppliedPaths() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let mainPath = packageRoot
            .appendingPathComponent("Sources")
            .appendingPathComponent("OrcaComputerUseMacOS")
            .appendingPathComponent("main.swift")
        let source = try String(contentsOf: mainPath, encoding: .utf8)

        // Why: --agent accepts caller-supplied paths; deleting them in the
        // helper can remove user files if argument validation is bypassed.
        XCTAssertFalse(source.contains("unlink(tokenPath)"))
        XCTAssertFalse(source.contains("unlink(socketPath)"))
    }

    func testSyntheticModifiersHaveGuaranteedReleaseAndModifiedClicksUseFlags() throws {
        let source = try agentEntrypointSource()

        XCTAssertTrue(source.contains("var pressedModifiers: [KeyModifier] = []"))
        XCTAssertTrue(source.contains(
            """
            defer {
                        for modifier in pressedModifiers.reversed() {
                            flags.remove(modifier.flag)
                            try? keyEvent(modifier.keyCode, down: false, flags: flags, pid: pid)
            """
        ))
        // Why: synthetic mouse delivery must set modifier flags and use the HID
        // tap path so coordinate clicks actually press (#12592), not only move.
        XCTAssertTrue(source.contains("event.flags = flags"))
        XCTAssertTrue(source.contains("event.post(tap: .cghidEventTap)"))
        XCTAssertTrue(source.contains("event.postToPid(pid)"))
        XCTAssertTrue(source.contains("mouseEventClickState"))
        // Why: whole-file contains(cghidEventTap) is satisfied by keyEvent alone;
        // pin the mouse button-press branch so the #12592 path cannot regress.
        XCTAssertTrue(
            source.contains(
                """
                        if isButtonPress {
                            event.post(tap: .cghidEventTap)
                        } else {
                            event.postToPid(pid)
                        }
                """
            ),
            "Input.mouse must HID-post button presses and postToPid motion without dual-post"
        )
    }

    private func agentEntrypointSource() throws -> String {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let mainPath = packageRoot
            .appendingPathComponent("Sources")
            .appendingPathComponent("OrcaComputerUseMacOS")
            .appendingPathComponent("main.swift")
        return try String(contentsOf: mainPath, encoding: .utf8)
    }
}
