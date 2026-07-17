import XCTest
@testable import OrcaComputerUseMacOSCore

final class AgentConnectionOwnershipTests: XCTestCase {
    func testAuthorizedHandshakeWithMatchingTokenClaimsHelperLifetime() {
        XCTAssertTrue(
            AgentConnectionOwnership.shouldClaim(
                method: "handshake",
                requestToken: "secret",
                expectedToken: "secret",
                authorizedPeer: true
            )
        )
    }

    func testUnauthorizedOrInvalidRequestsCannotClaimHelperLifetime() {
        let cases: [(method: String, token: String?, authorized: Bool)] = [
            ("handshake", "wrong", true),
            ("handshake", "secret", false),
            ("listApps", "secret", true),
        ]

        for testCase in cases {
            XCTAssertFalse(
                AgentConnectionOwnership.shouldClaim(
                    method: testCase.method,
                    requestToken: testCase.token,
                    expectedToken: "secret",
                    authorizedPeer: testCase.authorized
                )
            )
        }
    }

    func testStaleOwnerCannotTerminateNewerOwner() throws {
        let ownership = AgentConnectionOwnershipState()
        let first = try XCTUnwrap(ownership.claim())
        let second = try XCTUnwrap(ownership.claim())

        XCTAssertFalse(ownership.beginTermination(ifCurrent: first))
        XCTAssertTrue(ownership.beginTermination(ifCurrent: second))
    }

    func testOwnershipCannotChangeAfterTerminationBegins() throws {
        let ownership = AgentConnectionOwnershipState()
        let owner = try XCTUnwrap(ownership.claim())

        XCTAssertTrue(ownership.beginTermination(ifCurrent: owner))
        XCTAssertNil(ownership.claim())
        XCTAssertFalse(ownership.beginTermination(ifCurrent: owner))
    }
}
