import OrcaComputerUseMacOSCore
import XCTest

final class ComputerSnapshotCachePolicyTests: XCTestCase {
    func testDoesNotExpireFreshSnapshotsAtTheAgeBoundary() {
        let createdAt = Date(timeIntervalSince1970: 100)
        let now = createdAt.addingTimeInterval(ComputerSnapshotCachePolicy.maxAge)

        XCTAssertFalse(ComputerSnapshotCachePolicy.isExpired(createdAt: createdAt, now: now))
    }

    func testExpiresSnapshotsOlderThanTheAgeLimit() {
        let createdAt = Date(timeIntervalSince1970: 100)
        let now = createdAt.addingTimeInterval(ComputerSnapshotCachePolicy.maxAge + 0.001)

        XCTAssertTrue(ComputerSnapshotCachePolicy.isExpired(createdAt: createdAt, now: now))
    }

    func testPrunesWhenCacheExceedsEntryLimit() {
        XCTAssertTrue(
            ComputerSnapshotCachePolicy.shouldPrune(
                entryCount: ComputerSnapshotCachePolicy.maxEntries + 1,
                createdAt: Date(),
                now: Date()
            )
        )
    }
}
