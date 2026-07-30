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

    func testAgentUsesExactKernelPeerPidWithoutProcessInspection() throws {
        let source = try agentEntrypointSource()

        XCTAssertTrue(source.contains(
            """
            let authorizedPeer = isAuthorizedAgentPeer(
                        peerProcessId: peerProcessId(fd),
                        expectedProcessId: expectedPeerProcessId
            """
        ))
        XCTAssertFalse(source.contains("/bin/ps"))
        XCTAssertFalse(source.contains("computer-sidecar.js"))
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
