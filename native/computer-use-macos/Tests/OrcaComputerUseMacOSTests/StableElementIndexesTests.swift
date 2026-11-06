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

    func testARemovedIndexIsNeverHandedToADifferentNewElement() {
        let previous: [Previous] = [("window", 0, "AXWindow"), ("search", 1, "AXTextField")]

        let result = assign([("window", "AXWindow"), ("new row", "AXRow")], previous: previous, nextFresh: 7)

        XCTAssertEqual(result.indexes, [0, 7])
    }

}
