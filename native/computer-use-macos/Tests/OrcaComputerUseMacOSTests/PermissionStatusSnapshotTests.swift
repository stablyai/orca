import Dispatch
@testable import OrcaComputerUseMacOSCore
import XCTest

final class PermissionStatusSnapshotTests: XCTestCase {
    func testCapturesBothPermissionResults() {
        let snapshot = PermissionStatusSnapshotProbe.capture(
            accessibilityProbe: { true },
            screenshotsProbe: { false }
        )

        XCTAssertEqual(
            snapshot,
            PermissionStatusSnapshot(accessibilityGranted: true, screenshotsGranted: false)
        )
    }

    func testRunsPermissionProbesConcurrently() {
        let accessibilityStarted = DispatchSemaphore(value: 0)
        let screenshotsStarted = DispatchSemaphore(value: 0)
        let releaseProbes = DispatchSemaphore(value: 0)
        let finished = expectation(description: "permission snapshot")

        DispatchQueue.global().async {
            _ = PermissionStatusSnapshotProbe.capture(
                accessibilityProbe: {
                    accessibilityStarted.signal()
                    releaseProbes.wait()
                    return true
                },
                screenshotsProbe: {
                    screenshotsStarted.signal()
                    releaseProbes.wait()
                    return true
                }
            )
            finished.fulfill()
        }

        XCTAssertEqual(accessibilityStarted.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(screenshotsStarted.wait(timeout: .now() + 1), .success)
        releaseProbes.signal()
        releaseProbes.signal()
        wait(for: [finished], timeout: 1)
    }

    func testCoalescesRefreshesWhileProbeIsRunning() {
        let callbackQueue = DispatchQueue(label: "permission-status-test-callback")
        let probeStarted = DispatchSemaphore(value: 0)
        let releaseProbe = DispatchSemaphore(value: 0)
        let handled = expectation(description: "snapshot handled")
        let probeCount = LockedCounter()
        let coordinator = PermissionStatusRefreshCoordinator(
            callbackQueue: callbackQueue,
            probe: {
                probeCount.increment()
                probeStarted.signal()
                releaseProbe.wait()
                return PermissionStatusSnapshot(
                    accessibilityGranted: true,
                    screenshotsGranted: true
                )
            },
            handler: { _ in handled.fulfill() }
        )

        coordinator.refresh()
        XCTAssertEqual(probeStarted.wait(timeout: .now() + 1), .success)
        coordinator.refresh()
        coordinator.refresh()
        releaseProbe.signal()

        wait(for: [handled], timeout: 1)
        XCTAssertEqual(probeCount.value, 1)
    }

    func testAllowsRefreshAfterPreviousSnapshotWasHandled() {
        let callbackQueue = DispatchQueue(label: "permission-status-test-callback")
        let firstHandled = expectation(description: "first snapshot handled")
        let secondHandled = expectation(description: "second snapshot handled")
        let probeCount = LockedCounter()
        let coordinator = PermissionStatusRefreshCoordinator(
            callbackQueue: callbackQueue,
            probe: {
                let count = probeCount.increment()
                return PermissionStatusSnapshot(
                    accessibilityGranted: count == 2,
                    screenshotsGranted: false
                )
            },
            handler: { snapshot in
                if snapshot.accessibilityGranted {
                    secondHandled.fulfill()
                } else {
                    firstHandled.fulfill()
                }
            }
        )

        coordinator.refresh()
        wait(for: [firstHandled], timeout: 1)
        coordinator.refresh()

        wait(for: [secondHandled], timeout: 1)
        XCTAssertEqual(probeCount.value, 2)
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    @discardableResult
    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return count
    }
}
