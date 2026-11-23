import Foundation
@testable import OrcaComputerUseMacOSCore
import XCTest

final class StandardRoleDescriptionsTests: XCTestCase {
    private let system = StandardRoleDescriptions.system()

    func testLocalizedStandardSubroleReadsInEnglish() {
        XCTAssertEqual(system.english(role: "AXWindow", description: "janela padrão"), "standard window")
    }

    func testEnglishSubroleDescriptionStaysTheSame() {
        XCTAssertEqual(system.english(role: "AXButton", description: "close button"), "close button")
    }

    func testAppWordingIsNotStandard() {
        XCTAssertNil(system.english(role: "AXButton", description: "Send message"))
    }

    func testDescriptionSharedBySubrolesOfOneRoleIsKeptUnlessTheRoleOwnsIt() {
        let descriptions = StandardRoleDescriptions(tables: [
            "en": ["AXLink": "link", "AXLink:AXTextLink": "hyperlink", "AXList:A": "first", "AXList:B": "second"],
            "nl": ["AXLink": "link", "AXLink:AXTextLink": "link", "AXList:A": "lijst", "AXList:B": "lijst"],
        ])
        XCTAssertEqual(descriptions.english(role: "AXLink", description: "link"), "link")
        XCTAssertNil(descriptions.english(role: "AXList", description: "lijst"))
    }

    func testLocalizedStaticTextInlinesItsValue() throws {
        let roleDescription = try XCTUnwrap(system.english(role: "AXStaticText", description: "texto"))
        let node = SnapshotRenderNode(role: "AXStaticText", roleDescription: roleDescription, value: "0")
        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 3, node: node), "3 text 0")
    }
}
