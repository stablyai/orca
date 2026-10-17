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
        XCTAssertTrue(source.contains("event.flags = flags\n        event.postToPid(pid)"))
    }

    func testAgentServesPermissionStatusWithoutAProbeLaunchMode() throws {
        let source = try agentEntrypointSource()

        XCTAssertTrue(source.contains(
            """
                    case "permissionStatus":
                        // Why: Orca reads status from this long-lived agent instead of launching a probe app per check.
                        return permissionStatusSnapshotSettled().wireStatus
            """
        ))
        XCTAssertTrue(source.contains("\"permissions\": [\n                    \"status\": true,"))
        // Why: probe launches through LaunchServices wedged app launches system-wide (#29146).
        XCTAssertFalse(source.contains("--permission-status"))
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
