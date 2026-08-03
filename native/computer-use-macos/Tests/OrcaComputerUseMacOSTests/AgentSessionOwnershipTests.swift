import OrcaComputerUseMacOSCore
import XCTest

final class AgentSessionOwnershipTests: XCTestCase {
    func testUnclaimedDisconnectDoesNotTerminateAgent() {
        var ownership = AgentSessionOwnership()

        XCTAssertFalse(ownership.disconnect(connection(12)))
    }

    func testUnauthenticatedConnectionCannotClaimOrRetainAgent() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: false), .rejected)
        XCTAssertFalse(ownership.disconnect(connection(12)))
    }

    func testLastAuthenticatedDisconnectTerminatesAgent() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: true), .claimed)
        XCTAssertTrue(ownership.disconnect(connection(12)))
    }

    func testAgentWaitsForEveryAuthenticatedConnectionToClose() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: true), .claimed)
        XCTAssertEqual(ownership.registerConnection(connection(13), authenticated: true), .retained)
        XCTAssertFalse(ownership.disconnect(connection(12)))
        XCTAssertTrue(ownership.disconnect(connection(13)))
    }

    func testDuplicateRegistrationDoesNotRetainAgent() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: true), .claimed)
        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: true), .rejected)
        XCTAssertTrue(ownership.disconnect(connection(12)))
    }

    func testClosedSessionRejectsNewConnections() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(connection(12), authenticated: true), .claimed)
        XCTAssertTrue(ownership.disconnect(connection(12)))
        XCTAssertEqual(ownership.registerConnection(connection(13), authenticated: true), .rejected)
        XCTAssertFalse(ownership.disconnect(connection(13)))
    }

    func testStaleDisconnectCannotRemoveReusedFileDescriptorOwner() {
        var ownership = AgentSessionOwnership()
        let staleConnection = connection(12)
        let otherConnection = connection(13)
        let reusedDescriptorConnection = connection(14)

        XCTAssertEqual(ownership.registerConnection(staleConnection, authenticated: true), .claimed)
        XCTAssertEqual(ownership.registerConnection(otherConnection, authenticated: true), .retained)
        XCTAssertFalse(ownership.disconnect(staleConnection))
        XCTAssertEqual(
            ownership.registerConnection(reusedDescriptorConnection, authenticated: true),
            .retained
        )

        XCTAssertFalse(ownership.disconnect(staleConnection))
        XCTAssertFalse(ownership.disconnect(otherConnection))
        XCTAssertTrue(ownership.disconnect(reusedDescriptorConnection))
    }

    func testTokenlessSessionStillRequiresAuthorizedPeer() {
        XCTAssertFalse(isAuthenticatedAgentSession(
            expectedToken: nil,
            requestToken: nil,
            authorizedPeer: false
        ))
        XCTAssertTrue(isAuthenticatedAgentSession(
            expectedToken: nil,
            requestToken: nil,
            authorizedPeer: true
        ))
    }

    func testTokenSessionRequiresAuthorizedPeerAndMatchingToken() {
        XCTAssertFalse(isAuthenticatedAgentSession(
            expectedToken: "expected",
            requestToken: "expected",
            authorizedPeer: false
        ))
        XCTAssertFalse(isAuthenticatedAgentSession(
            expectedToken: "expected",
            requestToken: "wrong",
            authorizedPeer: true
        ))
        XCTAssertTrue(isAuthenticatedAgentSession(
            expectedToken: "expected",
            requestToken: "expected",
            authorizedPeer: true
        ))
    }
}

private func connection(_ rawValue: UInt64) -> AgentSessionConnectionID {
    AgentSessionConnectionID(rawValue: rawValue)
}
