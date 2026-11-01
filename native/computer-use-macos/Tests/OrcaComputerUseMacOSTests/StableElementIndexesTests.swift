import OrcaComputerUseMacOSCore
import XCTest

final class StableElementIndexesTests: XCTestCase {
    private typealias Previous = (key: String, index: Int, signature: String)

    private func assign(_ current: [(String, String)], previous: [Previous] = [], nextFresh: Int = 0) -> (indexes: [Int], nextFreshIndex: Int) {
        StableElementIndexes.assign(
            current: current.map { $0.0 },
            previous: previous.map { (key: $0.key, index: $0.index) },
            previousNextFreshIndex: nextFresh
        )
    }

    func testFirstSnapshotNumbersElementsInWalkOrder() {
        XCTAssertEqual(assign([("window", "AXWindow"), ("search", "AXTextField"), ("row", "AXRow")]).indexes, [0, 1, 2])
    }

    func testAnElementInsertedEarlyLeavesEveryOtherIndexAlone() {
        let previous: [Previous] = [("window", 0, "AXWindow"), ("search", 1, "AXTextField"), ("row", 2, "AXRow")]

        let result = assign(
            [("window", "AXWindow"), ("clear", "AXButton"), ("search", "AXTextField"), ("row", "AXRow")],
            previous: previous,
            nextFresh: 3
        )

        XCTAssertEqual(result.indexes, [0, 3, 1, 2])
        XCTAssertEqual(result.nextFreshIndex, 4)
    }

    func testIdentityWinsOverSignatureForLookalikeSiblings() {
        // A new unnamed container above two existing ones must not take an existing container's index.
        let previous: [Previous] = [("window", 0, "AXWindow"), ("groupA", 1, "AXGroup"), ("groupB", 2, "AXGroup")]

        let result = assign(
            [("window", "AXWindow"), ("groupNew", "AXGroup"), ("groupA", "AXGroup"), ("groupB", "AXGroup")],
            previous: previous,
            nextFresh: 3
        )

        XCTAssertEqual(result.indexes, [0, 3, 1, 2])
    }

    func testElementsRebuiltOnEveryReadReceiveFreshIndexes() {
        let previous: [Previous] = [("window", 0, "AXWindow"), ("cell-old-1", 1, "AXCell|Name"), ("cell-old-2", 2, "AXCell|Size")]

        let result = assign(
            [("window", "AXWindow"), ("cell-new-1", "AXCell|Name"), ("cell-new-2", "AXCell|Size")],
            previous: previous,
            nextFresh: 3
        )

        XCTAssertEqual(result.indexes, [0, 3, 4])
        XCTAssertEqual(result.nextFreshIndex, 5)
    }

    func testALookalikeReplacementCannotInheritARemovedElementsIndex() {
        let previous: [Previous] = [("window", 0, "AXWindow"), ("buttonA", 1, "AXButton|Delete"), ("buttonB", 2, "AXButton|Keep")]

        let result = assign(
            [("window", "AXWindow"), ("buttonC", "AXButton|Delete"), ("buttonB", "AXButton|Keep")],
            previous: previous,
            nextFresh: 3
        )

        XCTAssertEqual(result.indexes, [0, 3, 2])
    }

    func testARemovedIndexIsNeverHandedToADifferentNewElement() {
        let previous: [Previous] = [("window", 0, "AXWindow"), ("search", 1, "AXTextField")]

        let result = assign([("window", "AXWindow"), ("new row", "AXRow")], previous: previous, nextFresh: 7)

        XCTAssertEqual(result.indexes, [0, 7])
    }

    func testRenumbersOnlyTheLeadingElementIndex() {
        let indexes = [3: 41, 12: 3]

        XCTAssertEqual(StableElementIndexes.renumber(line: "\t\t3 button Upvote 12", indexes: indexes), "\t\t41 button Upvote 12")
        XCTAssertEqual(StableElementIndexes.renumber(line: "12", indexes: indexes), "3")
        XCTAssertEqual(StableElementIndexes.renumber(line: "\t... 12 inactive browser tabs omitted", indexes: indexes), "\t... 12 inactive browser tabs omitted")
        XCTAssertEqual(StableElementIndexes.renumber(line: "\t12px text", indexes: indexes), "\t12px text")
    }
}
