import XCTest
@testable import OrcaComputerUseMacOSCore

final class SnapshotRenderingTests: XCTestCase {
    func testElidesAnonymousWrappers() {
        let node = SnapshotRenderNode(role: "AXGroup", childCount: 1)

        XCTAssertTrue(SnapshotRenderHeuristics.shouldElide(node))
    }

    func testPreservesWebAreaContainersWithMultipleChildren() {
        let node = SnapshotRenderNode(role: "AXGroup", childCount: 3, webAreaDepth: 1)

        XCTAssertFalse(SnapshotRenderHeuristics.shouldElide(node))
    }

    func testRendersMarkdownLinksAndSuppressesTheirChildren() {
        let node = SnapshotRenderNode(role: "AXLink", linkText: "Skip [main]", url: "https://example.com/path")

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 7, node: node), "7 link [Skip \\[main\\]](https://example.com/path)")
        XCTAssertTrue(SnapshotRenderHeuristics.shouldSuppressChildren(node))
    }

    func testSuppressesChildrenForNamedCompactControls() {
        let button = SnapshotRenderNode(role: "AXButton", roleDescription: "button", label: "Install GitHub", childCount: 1)
        let heading = SnapshotRenderNode(role: "AXHeading", roleDescription: "heading", label: "Repository navigation", value: "2", childCount: 1)

        XCTAssertTrue(SnapshotRenderHeuristics.shouldSuppressChildren(button))
        XCTAssertTrue(SnapshotRenderHeuristics.shouldSuppressChildren(heading))
        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 5, node: heading), "5 heading Repository navigation")
    }

    func testKeepsChildrenForRowsWithNestedControls() {
        let row = SnapshotRenderNode(role: "AXRow", roleDescription: "row", childCount: 3, rowSummary: "Liked Songs")

        XCTAssertFalse(SnapshotRenderHeuristics.shouldSuppressChildren(row))
    }

    func testFiltersNoisyActionsAndFormatsSecondaryActions() {
        let node = SnapshotRenderNode(
            role: "AXWindow",
            title: "Document",
            rawActions: ["AXPress", "AXShowMenu", "AXScrollToVisible", "AXZoomWindow"]
        )

        XCTAssertEqual(SnapshotRenderHeuristics.meaningfulActions(node.rawActions, role: node.role), ["AXZoomWindow"])
        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 1, node: node), "1 window Document, Secondary Actions: zoom the window")
    }

    func testSuppressesHorizontalScrollWhenVerticalScrollExists() {
        let node = SnapshotRenderNode(
            role: "AXScrollArea",
            rawActions: ["AXScrollUpByPage", "AXScrollDownByPage", "AXScrollLeftByPage", "AXScrollRightByPage"]
        )

        XCTAssertEqual(SnapshotRenderHeuristics.meaningfulActions(node.rawActions, role: node.role), ["AXScrollUpByPage", "AXScrollDownByPage"])
    }

    func testTextFieldsKeepDistinctValueAndPlaceholder() {
        let node = SnapshotRenderNode(
            role: "AXTextField",
            roleDescription: "text field",
            label: "Address",
            value: "https://example.com",
            placeholder: "Search"
        )

        XCTAssertEqual(
            SnapshotRenderHeuristics.line(index: 3, node: node),
            "3 text field Address, Value: https://example.com, Placeholder: Search"
        )
    }

    func testStaticTextUsesCompactValueFormatting() {
        let node = SnapshotRenderNode(role: "AXStaticText", roleDescription: "text", value: "Home")

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 4, node: node), "4 text Home")
    }

    func testRowSummaryBecomesName() {
        let node = SnapshotRenderNode(role: "AXRow", roleDescription: "row", rowSummary: "General Settings Enabled")

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 9, node: node), "9 row General Settings Enabled")
    }
}
