import OrcaComputerUseMacOSCore
import XCTest

final class ForegroundEffectTests: XCTestCase {
    private typealias Node = ForegroundEffect.Node

    func testPressingAMenuOwnerOrItsLabelShowsAMenu() {
        for role in ["AXPopUpButton", "AXMenuButton", "AXComboBox"] {
            XCTAssertEqual(ForegroundEffect.ofPress([Node(role: role)]), .showsMenu, role)
            XCTAssertEqual(ForegroundEffect.ofPress([Node(role: "AXStaticText", labels: ["Small"]), Node(role: role)]), .showsMenu, role)
        }
    }

    func testAWebComboboxIsATextInputNotAMenu() {
        XCTAssertNil(ForegroundEffect.ofPress([Node(role: "AXComboBox", inWebContent: true)]))
        XCTAssertEqual(ForegroundEffect.ofPress([Node(role: "AXPopUpButton", inWebContent: true)]), .showsMenu)
    }

    func testOnlyAButtonWhoseTitleEndsInAnEllipsisOpensADialog() {
        XCTAssertEqual(ForegroundEffect.ofPress([Node(role: "AXButton", labels: ["Save\u{2026}", nil])]), .opensDialog)
        XCTAssertEqual(ForegroundEffect.ofPress([Node(role: "AXButton", labels: [nil, "Export... "])]), .opensDialog)
        XCTAssertNil(ForegroundEffect.ofPress([Node(role: "AXButton", labels: ["Save", "Saves the file\u{2026} now"])]))
        XCTAssertNil(ForegroundEffect.ofPress([Node(role: "AXLink", labels: ["Read more..."])]))
        XCTAssertNil(ForegroundEffect.ofPress([Node(role: "AXStaticText", labels: ["Loading..."]), Node(role: "AXGroup")]))
    }

    func testContextMenuClicksShowAMenuOnAnyTarget() {
        let plainButton = [Node(role: "AXButton", labels: ["OK"])]
        XCTAssertEqual(ForegroundEffect.ofClick(button: .right, control: false, target: plainButton), .showsMenu)
        XCTAssertEqual(ForegroundEffect.ofClick(button: .left, control: true, target: plainButton), .showsMenu)
        XCTAssertNil(ForegroundEffect.ofClick(button: .left, control: false, target: plainButton))
        XCTAssertEqual(ForegroundEffect.ofAction("AXShowMenu", target: plainButton), .showsMenu)
        XCTAssertNil(ForegroundEffect.ofAction("AXScrollToVisible", target: [Node(role: "AXPopUpButton")]))
        XCTAssertEqual(ForegroundEffect.ofAction("AXConfirm", target: [Node(role: "AXButton", labels: ["Open\u{2026}"])]), .opensDialog)
    }
}
