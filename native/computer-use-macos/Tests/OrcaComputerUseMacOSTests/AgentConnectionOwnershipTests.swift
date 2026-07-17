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
}
