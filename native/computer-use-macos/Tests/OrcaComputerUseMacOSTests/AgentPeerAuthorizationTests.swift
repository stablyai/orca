import XCTest
@testable import OrcaComputerUseMacOSCore

final class AgentPeerAuthorizationTests: XCTestCase {
    func testParsesExactAgentArguments() {
        XCTAssertEqual(
            AgentLaunchArguments.parse([
                "--agent",
                "/private/tmp/provider.sock",
                "--token-file",
                "/private/tmp/provider.token",
                "--peer-pid",
                "4321",
            ]),
            AgentLaunchArguments(
                socketPath: "/private/tmp/provider.sock",
                tokenFilePath: "/private/tmp/provider.token",
                expectedPeerProcessId: 4321
            )
        )
    }

    func testRejectsMissingReorderedOrExtraAgentArguments() {
        XCTAssertNil(AgentLaunchArguments.parse([
            "--agent", "/tmp/provider.sock", "--token-file", "/tmp/provider.token",
        ]))
        XCTAssertNil(AgentLaunchArguments.parse([
            "--agent", "/tmp/provider.sock", "--peer-pid", "4321",
            "--token-file", "/tmp/provider.token",
        ]))
        XCTAssertNil(AgentLaunchArguments.parse([
            "--agent", "/tmp/provider.sock", "--token-file", "/tmp/provider.token",
            "--peer-pid", "4321", "--extra",
        ]))
    }

    func testRejectsInvalidPeerProcessIds() {
        for value in ["", "0", "-1", "not-a-pid", "2147483648"] {
            XCTAssertNil(AgentLaunchArguments.parse([
                "--agent", "/tmp/provider.sock", "--token-file", "/tmp/provider.token",
                "--peer-pid", value,
            ]))
        }
    }

    func testAuthorizesOnlyTheExpectedPeerProcess() {
        XCTAssertTrue(isAuthorizedAgentPeer(peerProcessId: 4321, expectedProcessId: 4321))
        XCTAssertFalse(isAuthorizedAgentPeer(peerProcessId: 4322, expectedProcessId: 4321))
        XCTAssertFalse(isAuthorizedAgentPeer(peerProcessId: nil, expectedProcessId: 4321))
        XCTAssertFalse(isAuthorizedAgentPeer(peerProcessId: 4321, expectedProcessId: 0))
    }
}
