import OrcaComputerUseMacOSCore
import XCTest

final class AgentSessionOwnershipTests: XCTestCase {
    func testUnclaimedDisconnectDoesNotTerminateAgent() {
        var ownership = AgentSessionOwnership()

        XCTAssertFalse(ownership.disconnect(12))
    }

    func testUnauthenticatedConnectionCannotClaimOrRetainAgent() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(12, authenticated: false), .rejected)
        XCTAssertFalse(ownership.disconnect(12))
    }

    func testLastAuthenticatedDisconnectTerminatesAgent() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(12, authenticated: true), .claimed)
        XCTAssertTrue(ownership.disconnect(12))
    }

    func testAgentWaitsForEveryAuthenticatedConnectionToClose() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(12, authenticated: true), .claimed)
        XCTAssertEqual(ownership.registerConnection(13, authenticated: true), .joined)
        XCTAssertFalse(ownership.disconnect(12))
        XCTAssertTrue(ownership.disconnect(13))
    }

    func testDuplicateRegistrationDoesNotRetainAgent() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(12, authenticated: true), .claimed)
        XCTAssertEqual(ownership.registerConnection(12, authenticated: true), .joined)
        XCTAssertTrue(ownership.disconnect(12))
    }

    func testReleasedSessionCannotBeReclaimed() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(12, authenticated: true), .claimed)
        XCTAssertTrue(ownership.disconnect(12))
        XCTAssertEqual(ownership.registerConnection(13, authenticated: true), .sessionReleased)
        XCTAssertFalse(ownership.disconnect(13))
    }
}
