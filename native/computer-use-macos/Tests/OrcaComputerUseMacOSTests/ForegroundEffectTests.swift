import OrcaComputerUseMacOSCore
import XCTest

final class ForegroundEffectTests: XCTestCase {
    func testPressingAMenuOwnerOrItsLabelShowsAMenu() {
        for role in ["AXPopUpButton", "AXMenuButton", "AXComboBox"] {
            XCTAssertEqual(ForegroundEffect.ofPress([(role: role, labels: [])]), .showsMenu, role)
            XCTAssertEqual(ForegroundEffect.ofPress([(role: "AXStaticText", labels: ["Small"]), (role: role, labels: [])]), .showsMenu, role)
        }
        XCTAssertNil(ForegroundEffect.ofPress([
            (role: "AXStaticText", labels: []), (role: "AXGroup", labels: []), (role: "AXPopUpButton", labels: []),
        ]))
    }

    func testOnlyAButtonWhoseTitleEndsInAnEllipsisOpensADialog() {
        XCTAssertEqual(ForegroundEffect.ofPress([(role: "AXButton", labels: ["Save\u{2026}", nil])]), .opensDialog)
        XCTAssertEqual(ForegroundEffect.ofPress([(role: "AXButton", labels: [nil, "Export... "])]), .opensDialog)
        XCTAssertNil(ForegroundEffect.ofPress([(role: "AXButton", labels: ["Save", "Saves the file\u{2026} now"])]))
        XCTAssertNil(ForegroundEffect.ofPress([(role: "AXLink", labels: ["Read more..."])]))
        XCTAssertNil(ForegroundEffect.ofPress([(role: "AXStaticText", labels: ["Loading..."]), (role: "AXGroup", labels: [])]))
    }

    func testContextMenuClicksShowAMenuOnAnyTarget() {
        let plainButton: [(role: String?, labels: [String?])] = [(role: "AXButton", labels: ["OK"])]
        XCTAssertEqual(ForegroundEffect.ofClick(button: .right, control: false, target: plainButton), .showsMenu)
        XCTAssertEqual(ForegroundEffect.ofClick(button: .left, control: true, target: plainButton), .showsMenu)
        XCTAssertNil(ForegroundEffect.ofClick(button: .left, control: false, target: plainButton))
        XCTAssertEqual(ForegroundEffect.ofAction("AXShowMenu", target: plainButton), .showsMenu)
        XCTAssertNil(ForegroundEffect.ofAction("AXScrollToVisible", target: [(role: "AXPopUpButton", labels: [])]))
    }
}
