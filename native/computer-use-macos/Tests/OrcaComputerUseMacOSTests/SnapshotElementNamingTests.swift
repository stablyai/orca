import XCTest
@testable import OrcaComputerUseMacOSCore

final class SnapshotElementNamingTests: XCTestCase {
    func testSwiftUIDescriptionIsReadWhenOnlyTheAttributedDescriptionIsAdvertised() {
        let swiftUIButton: Set<String> = ["AXRole", "AXRoleDescription", "AXAttributedDescription"]
        XCTAssertTrue(SnapshotRenderHeuristics.supportsAttribute("AXDescription", advertisedAttributes: swiftUIButton))
        XCTAssertFalse(SnapshotRenderHeuristics.supportsAttribute("AXDescription", advertisedAttributes: ["AXRole"]))
    }

    func testACustomActionRendersOnlyItsName() {
        XCTAssertEqual(SnapshotRenderHeuristics.prettyAction("Name:Copiar\nTarget:0x0\nSelector:(null)"), "Copiar")
    }
}
