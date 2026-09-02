import Dispatch
import Foundation

public struct PermissionStatusSnapshot: Equatable, Sendable {
    public let accessibilityGranted: Bool
    public let screenshotsGranted: Bool

    public init(accessibilityGranted: Bool, screenshotsGranted: Bool) {
        self.accessibilityGranted = accessibilityGranted
        self.screenshotsGranted = screenshotsGranted
    }
}

public enum PermissionStatusSnapshotProbe {
    public typealias Probe = @Sendable () -> Bool

    private static let probeQueue = DispatchQueue(
        label: "com.stablyai.orca.computer-use-permission-status",
        attributes: .concurrent
    )

    public static func capture(
        accessibilityProbe: @escaping Probe,
        screenshotsProbe: @escaping Probe
    ) -> PermissionStatusSnapshot {
        let result = PermissionStatusSnapshotResult()
        let group = DispatchGroup()

        group.enter()
        probeQueue.async {
            result.recordAccessibility(accessibilityProbe())
            group.leave()
        }
        group.enter()
        probeQueue.async {
            result.recordScreenshots(screenshotsProbe())
            group.leave()
        }
        group.wait()
        return result.snapshot
    }
}

public final class PermissionStatusRefreshCoordinator: @unchecked Sendable {
    public typealias SnapshotProbe = @Sendable () -> PermissionStatusSnapshot
    public typealias SnapshotHandler = @Sendable (PermissionStatusSnapshot) -> Void

    private let callbackQueue: DispatchQueue
    private let handler: SnapshotHandler
    private let probe: SnapshotProbe
    private let stateLock = NSLock()
    private let workerQueue: DispatchQueue
    private var refreshInFlight = false

    public init(
        workerQueue: DispatchQueue = DispatchQueue(
            label: "com.stablyai.orca.computer-use-permission-refresh",
            qos: .userInitiated
        ),
        callbackQueue: DispatchQueue = .main,
        probe: @escaping SnapshotProbe,
        handler: @escaping SnapshotHandler
    ) {
        self.workerQueue = workerQueue
        self.callbackQueue = callbackQueue
        self.probe = probe
        self.handler = handler
    }

    public func refresh() {
        stateLock.lock()
        guard !refreshInFlight else {
            stateLock.unlock()
            return
        }
        refreshInFlight = true
        stateLock.unlock()

        workerQueue.async { [self] in
            let snapshot = probe()
            callbackQueue.async { [self] in
                stateLock.lock()
                refreshInFlight = false
                stateLock.unlock()
                handler(snapshot)
            }
        }
    }
}

private final class PermissionStatusSnapshotResult: @unchecked Sendable {
    private let lock = NSLock()
    private var accessibilityGranted = false
    private var screenshotsGranted = false

    var snapshot: PermissionStatusSnapshot {
        lock.lock()
        defer { lock.unlock() }
        return PermissionStatusSnapshot(
            accessibilityGranted: accessibilityGranted,
            screenshotsGranted: screenshotsGranted
        )
    }

    func recordAccessibility(_ granted: Bool) {
        lock.lock()
        accessibilityGranted = granted
        lock.unlock()
    }

    func recordScreenshots(_ granted: Bool) {
        lock.lock()
        screenshotsGranted = granted
        lock.unlock()
    }
}
