import CoreGraphics
import OrcaComputerUseMacOSCore
import XCTest

final class ElementActionabilityTests: XCTestCase {
    private final class FakeTree: ElementActionabilityAccessibility {
        struct Node {
            var role: String
            var parent: Int?
            var frame: CGRect
            var enabled: Bool? = true
            var modal = false
            /// Hides the parts of descendants outside its frame from hit tests, as a scroller does.
            var clips = false
            /// Where the node sits after AXScrollToVisible; nil when it offers no scroll.
            var scrollsTo: CGRect?
        }

        var nodes: [Int: Node]
        var retriesLeft = 5

        init(_ nodes: [Int: Node]) {
            self.nodes = nodes
        }

        func isEnabled(_ element: Int) -> Bool? { nodes[element]?.enabled }
        func frame(of element: Int) -> CGRect? { nodes[element]?.frame }
        func role(of element: Int) -> String? { nodes[element]?.role }
        func parent(of element: Int) -> Int? { nodes[element]?.parent }
        func isSame(_ lhs: Int, _ rhs: Int) -> Bool { lhs == rhs }
        func isModal(_ window: Int) -> Bool { nodes[window]?.modal == true }

        /// The highest-numbered node under the point is on top.
        func element(at point: CGPoint) -> Int? {
            nodes.keys.filter { shows($0, at: point) }.max()
        }

        private func shows(_ id: Int, at point: CGPoint) -> Bool {
            guard let node = nodes[id], node.frame.contains(point) else { return false }
            var ancestor = node.parent
            while let current = ancestor.flatMap({ nodes[$0] }) {
                if current.clips, !current.frame.contains(point) { return false }
                ancestor = current.parent
            }
            return true
        }

        func scrollToVisible(_ element: Int) throws -> Bool {
            guard let target = nodes[element]?.scrollsTo else { return false }
            nodes[element]?.frame = target
            return true
        }

        func waitBeforeRetry() -> Bool {
            guard retriesLeft > 0 else { return false }
            retriesLeft -= 1
            return true
        }
    }

    private let window = CGRect(x: 0, y: 0, width: 400, height: 300)

    /// A window with a scroll area showing y 0-200 and a button inside it.
    private func scrollingWindow(button: FakeTree.Node) -> FakeTree {
        FakeTree([
            1: .init(role: "AXWindow", parent: nil, frame: window),
            2: .init(role: "AXScrollArea", parent: 1, frame: CGRect(x: 0, y: 0, width: 400, height: 200), clips: true),
            3: button,
        ])
    }

    func testADisabledElementIsRefusedWithoutAPoint() throws {
        let tree = scrollingWindow(button: .init(role: "AXButton", parent: 2, frame: CGRect(x: 10, y: 10, width: 80, height: 20), enabled: false))

        guard case .notEnabled = try ElementActionability.pointerTarget(3, windowFrame: window, ax: tree) else {
            return XCTFail("a disabled button must not get a click point")
        }
        XCTAssertFalse(ElementActionability.waitUntilEnabled(3, ax: tree))
    }

    func testAnElementThatCannotBeScrolledIntoViewIsRefused() throws {
        let tree = scrollingWindow(button: .init(role: "AXButton", parent: 2, frame: CGRect(x: 10, y: 250, width: 80, height: 20)))

        guard case .outOfView(scrolled: false) = try ElementActionability.pointerTarget(3, windowFrame: window, ax: tree) else {
            return XCTFail("a button clipped by its scroll area must not be clicked")
        }
    }

    func testAnElementBiggerThanItsScrollAreaIsClickedWhereItShowsWithoutScrolling() throws {
        let tree = scrollingWindow(button: .init(
            role: "AXGroup",
            parent: 2,
            frame: CGRect(x: 0, y: 100, width: 400, height: 1000),
            scrollsTo: CGRect(x: 0, y: 0, width: 400, height: 1000)
        ))

        guard case let .ready(point) = try ElementActionability.pointerTarget(3, windowFrame: window, ax: tree) else {
            return XCTFail("the visible part of the group should take the click")
        }
        XCTAssertEqual(point, CGPoint(x: 200, y: 150))
    }

    func testACoveredElementIsRefusedAndNamesWhatCoversIt() throws {
        let tree = scrollingWindow(button: .init(role: "AXButton", parent: 2, frame: CGRect(x: 10, y: 10, width: 80, height: 20)))
        tree.nodes[4] = .init(role: "AXSheet", parent: 1, frame: CGRect(x: 0, y: 0, width: 400, height: 100))

        guard case let .covered(by: cover) = try ElementActionability.pointerTarget(3, windowFrame: window, ax: tree) else {
            return XCTFail("a button under a sheet must not be clicked")
        }
        XCTAssertEqual(cover, 4)
    }

    func testARowUnderAStickyHeaderIsScrolledClearThenClicked() throws {
        let tree = scrollingWindow(button: .init(
            role: "AXRow",
            parent: 2,
            frame: CGRect(x: 0, y: 0, width: 100, height: 20),
            scrollsTo: CGRect(x: 0, y: 40, width: 100, height: 20)
        ))
        tree.nodes[4] = .init(role: "AXGroup", parent: 2, frame: CGRect(x: 0, y: 0, width: 400, height: 30))

        guard case let .ready(point) = try ElementActionability.pointerTarget(3, windowFrame: window, ax: tree) else {
            return XCTFail("the row should be clicked once scrolled out from under the header")
        }
        XCTAssertEqual(point, CGPoint(x: 50, y: 50))
    }

    func testAnotherWindowOfTheAppOnTopDoesNotCoverTheTarget() throws {
        let tree = scrollingWindow(button: .init(role: "AXButton", parent: 2, frame: CGRect(x: 10, y: 10, width: 80, height: 20)))
        tree.nodes[5] = .init(role: "AXWindow", parent: nil, frame: CGRect(x: 0, y: 0, width: 200, height: 200))

        guard case .ready = try ElementActionability.pointerTarget(3, windowFrame: window, ax: tree) else {
            return XCTFail("background input goes to the target window even under another window of the app")
        }

        tree.nodes[5]?.modal = true
        guard case .covered(by: 5) = try ElementActionability.pointerTarget(3, windowFrame: window, ax: tree) else {
            return XCTFail("an app-modal window on top blocks input to the target window")
        }
    }

    func testAPartlyCoveredElementIsClickedWhereItShows() throws {
        let tree = scrollingWindow(button: .init(role: "AXButton", parent: 2, frame: CGRect(x: 0, y: 0, width: 100, height: 100)))
        tree.nodes[4] = .init(role: "AXGroup", parent: 2, frame: CGRect(x: 0, y: 0, width: 60, height: 100))

        guard case let .ready(point) = try ElementActionability.pointerTarget(3, windowFrame: window, ax: tree) else {
            return XCTFail("the uncovered right half should take the click")
        }
        XCTAssertEqual(point, CGPoint(x: 75, y: 25))
    }

    func testAHitOnTheElementsOwnChildCountsAsTheElement() throws {
        let tree = scrollingWindow(button: .init(role: "AXRow", parent: 2, frame: CGRect(x: 0, y: 0, width: 100, height: 20)))
        tree.nodes[4] = .init(role: "AXStaticText", parent: 3, frame: CGRect(x: 0, y: 0, width: 100, height: 20))

        guard case .ready = try ElementActionability.pointerTarget(3, windowFrame: window, ax: tree) else {
            return XCTFail("a hit on the row's own text is a hit on the row")
        }
    }

    func testAnElementHiddenByAScrollerThatIsNotAScrollAreaIsScrolledIntoViewFirst() throws {
        // A web overflow div shows as AXGroup (2), so only the window (1) answers below it.
        let tree = FakeTree([
            1: .init(role: "AXWindow", parent: nil, frame: window),
            2: .init(role: "AXGroup", parent: 1, frame: CGRect(x: 0, y: 0, width: 400, height: 100), clips: true),
            3: .init(
                role: "AXLink",
                parent: 2,
                frame: CGRect(x: 10, y: 150, width: 80, height: 20),
                scrollsTo: CGRect(x: 10, y: 50, width: 80, height: 20)
            ),
        ])

        guard case let .ready(point) = try ElementActionability.pointerTarget(3, windowFrame: window, ax: tree) else {
            return XCTFail("the link should be clicked once scrolled into its container's view")
        }
        XCTAssertEqual(point, CGPoint(x: 50, y: 60))
    }

    func testAHitOnTheElementsAncestorMeansNothingCoversIt() throws {
        // The group (9) is above the image (3) in hit order, as when the image ignores hit tests.
        let tree = FakeTree([
            1: .init(role: "AXWindow", parent: nil, frame: window),
            3: .init(role: "AXImage", parent: 9, frame: CGRect(x: 10, y: 10, width: 20, height: 20)),
            9: .init(role: "AXGroup", parent: 1, frame: window),
        ])

        guard case .ready = try ElementActionability.pointerTarget(3, windowFrame: window, ax: tree) else {
            return XCTFail("a hit on the element's own ancestor is not a covering element")
        }
    }
}
