import XCTest

final class AgentEntrypointSourceSafetyTests: XCTestCase {
    func testAgentEntrypointDoesNotUnlinkCallerSuppliedPaths() throws {
        let source = try ExecutableSourceFixture.read("main.swift")

        // Why: --agent accepts caller-supplied paths; deleting them in the
        // helper can remove user files if argument validation is bypassed.
        XCTAssertFalse(source.contains("unlink(tokenPath)"))
        XCTAssertFalse(source.contains("unlink(socketPath)"))
    }

    func testAgentEntrypointTrustsStableDevBundleIdentifier() throws {
        let source = try ExecutableSourceFixture.read("main.swift")

        // Why: the shared dev launcher uses this exact bundle id rather than
        // the per-worktree prefix used by older launchers.
        XCTAssertTrue(source.contains("bundleId == \"com.stablyai.orca.dev\""))
    }
}
