import OrcaComputerUseMacOSCore
import XCTest

final class RowSelectionClickTests: XCTestCase {
    private final class FakeTree: RowSelectionAccessibility {
        struct Node {
            var role: String
            var selected: Bool?
            var parent: Int?
            var settable: Set<String> = []
        }

        var nodes: [Int: Node]
        var acceptedWritesTakeEffect = true
        private(set) var writes: [String] = []

        init(_ nodes: [Int: Node]) {
            self.nodes = nodes
        }

        func role(of element: Int) -> String? { nodes[element]?.role }
        func isSelected(_ element: Int) -> Bool? { nodes[element]?.selected }
        func parent(of element: Int) -> Int? { nodes[element]?.parent }
        func isSettable(_ attribute: String, on element: Int) -> Bool { nodes[element]?.settable.contains(attribute) == true }

        func setSelected(_ element: Int) throws -> Bool {
            writes.append("AXSelected:\(element)")
            if acceptedWritesTakeEffect { select(element) }
            return true
        }

        func setSelection(_ attribute: String, of container: Int, to member: Int) throws -> Bool {
            writes.append("\(attribute):\(container):\(member)")
            if acceptedWritesTakeEffect { select(member) }
            return true
        }

        func settles(_ check: () -> Bool) -> Bool { check() }

        private func select(_ member: Int) {
            for id in nodes.keys where nodes[id]?.selected != nil {
                nodes[id]?.selected = id == member
            }
        }
    }

    private func outline(containerSettable: Set<String> = ["AXSelectedRows"], rowSettable: Set<String> = []) -> FakeTree {
        FakeTree([
            1: .init(role: "AXOutline", parent: nil, settable: containerSettable),
            2: .init(role: "AXRow", selected: true, parent: 1),
            3: .init(role: "AXRow", selected: false, parent: 1, settable: rowSettable),
            4: .init(role: "AXCell", parent: 3),
        ])
    }

    func testAClickThatSelectedTheRowNeedsNoWrite() throws {
        let tree = outline(rowSettable: ["AXSelected"])
        tree.nodes[3]?.selected = true

        XCTAssertEqual(try RowSelectionClick.confirm(3, ax: tree), .selectedByClick)
        XCTAssertEqual(tree.writes, [])
    }

    func testACellWrappedInAGroupIsSelectedThroughItsRow() throws {
        let tree = outline()
        tree.nodes[5] = .init(role: "AXGroup", parent: 3)
        tree.nodes[4]?.parent = 5

        XCTAssertTrue(RowSelectionClick.isUnselectedRow(4, ax: tree))
        XCTAssertEqual(try RowSelectionClick.confirm(4, ax: tree), .selectedByWrite(attribute: "AXSelectedRows"))
        XCTAssertEqual(tree.writes, ["AXSelectedRows:1:3"])
    }

    func testSelectedChildrenTakesTheContainersOwnChild() throws {
        let tree = outline(containerSettable: ["AXSelectedChildren"])

        XCTAssertEqual(try RowSelectionClick.confirm(4, ax: tree), .selectedByWrite(attribute: "AXSelectedChildren"))
        XCTAssertEqual(tree.writes, ["AXSelectedChildren:1:3"])
    }

    func testAnOuterListThatTakesWritesIsLeftAlone() throws {
        let tree = outline(containerSettable: [], rowSettable: ["AXSelected"])
        tree.nodes[10] = .init(role: "AXList", parent: nil, settable: ["AXSelectedChildren"])
        tree.nodes[11] = .init(role: "AXGroup", selected: false, parent: 10)
        tree.nodes[1]?.parent = 11

        XCTAssertEqual(try RowSelectionClick.confirm(3, ax: tree), .selectedByWrite(attribute: "AXSelected"))
        XCTAssertEqual(tree.writes, ["AXSelected:3"])
    }

    func testAnAcceptedWriteThatNeverShowsIsNotFollowedByAnotherWrite() throws {
        let tree = outline(rowSettable: ["AXSelected"])
        tree.acceptedWritesTakeEffect = false

        XCTAssertEqual(try RowSelectionClick.confirm(3, ax: tree), .unselected)
        XCTAssertEqual(tree.writes, ["AXSelectedRows:1:3"])
    }
}
