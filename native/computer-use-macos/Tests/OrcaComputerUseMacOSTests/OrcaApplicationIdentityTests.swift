import XCTest
@testable import OrcaComputerUseMacOSCore

final class OrcaApplicationIdentityTests: XCTestCase {
    func testPackagedAndSupportedDevelopmentHostsAreAuthorized() {
        for bundleId in ["com.stablyai.orca", "com.stablyai.orca.dev", "com.stablyai.orca.dev.worktree", "com.github.Electron"] {
            XCTAssertTrue(OrcaApplicationIdentity.isTrustedAgentHost(bundleId: bundleId))
        }
    }

    func testOtherDesktopAppsAndLookalikeBundlesAreUnauthorized() {
        for bundleId in ["com.stablyai.orca.computer-use", "com.stablyai.orca.developer", "com.stablyai.orca.unrelated", "com.apple.finder"] {
            XCTAssertFalse(OrcaApplicationIdentity.isTrustedAgentHost(bundleId: bundleId))
        }
    }
}
