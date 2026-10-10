import XCTest
@testable import OrcaComputerUseMacOSCore

final class ChromiumAccessibilityPolicyTests: XCTestCase {
    func testOrcaReleaseAndDevelopmentEnableChromiumAccessibility() {
        for bundleId in ["com.stablyai.orca", "com.stablyai.orca.dev", "COM.STABLYAI.ORCA"] {
            XCTAssertTrue(ChromiumAccessibilityPolicy.needsManualAccessibilityMode(bundleId: bundleId))
        }
    }

    func testNativeAppsAndUnrelatedOrcaBundlesKeepTheirAccessibilityMode() {
        for bundleId in [nil, "com.apple.finder", "com.apple.TextEdit", "com.stablyai.orca.computer-use", "com.stablyai.orca.unrelated"] {
            XCTAssertFalse(ChromiumAccessibilityPolicy.needsManualAccessibilityMode(bundleId: bundleId))
        }
    }

    func testPreviouslySupportedChromiumAppsStillEnableAccessibility() {
        for bundleId in ["com.google.chrome.canary", "com.github.electron", "com.tinyspeck.slackmacgap", "com.spotify.client", "notion.id"] {
            XCTAssertTrue(ChromiumAccessibilityPolicy.needsManualAccessibilityMode(bundleId: bundleId))
        }
    }
}
