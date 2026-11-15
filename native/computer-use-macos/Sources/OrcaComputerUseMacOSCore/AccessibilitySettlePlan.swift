import Foundation

/// Decides when to re-read the target after an action that showed no change at first, so a late change is caught.
///
/// Reads happen shortly after the app posts an accessibility notification instead of on a fixed 200 ms beat. Apps
/// that have shown they post notifications for their changes end the wait after a quiet window with no
/// notification; every other app keeps the 200 ms re-reads, so an app that changes silently is still caught.
/// Both keep the one-second ceiling.
public struct AccessibilitySettlePlan: Equatable {
    public static let ceiling: TimeInterval = 1
    /// Notifications come in bursts; read once the burst has paused this long.
    public static let debounce: TimeInterval = 0.075
    /// The old fixed beat; a read never waits longer than this after a notification, or after the last read
    /// for an app that does not post notifications.
    public static let pollInterval: TimeInterval = 0.2
    /// With no notification for this long, an app that posts them has nothing left to apply.
    public static let quietWindow: TimeInterval = 0.4

    public enum Step: Equatable {
        case wait(until: Date)
        case read
        case finish
    }

    public let start: Date
    public let appPostsNotifications: Bool
    private var lastRead: Date
    private var lastActivity: Date
    private var firstUnreadEvent: Date?
    private var lastUnreadEvent: Date?
    private var checkedQuiet = false

    /// `eventsBeforeStart` is true when the app posted notifications since the action began; the first read may
    /// have run before they took effect.
    public init(start: Date, appPostsNotifications: Bool, eventsBeforeStart: Bool) {
        self.start = start
        self.appPostsNotifications = appPostsNotifications
        lastRead = start
        lastActivity = start
        if eventsBeforeStart {
            firstUnreadEvent = start
            lastUnreadEvent = start
        }
    }

    public var deadline: Date { start.addingTimeInterval(Self.ceiling) }

    public var hasUnreadEvent: Bool { lastUnreadEvent != nil }

    public mutating func eventArrived(at time: Date) {
        if firstUnreadEvent == nil { firstUnreadEvent = time }
        lastUnreadEvent = time
        lastActivity = max(lastActivity, time)
    }

    public mutating func didRead(at time: Date) {
        lastRead = time
        firstUnreadEvent = nil
        lastUnreadEvent = nil
    }

    public mutating func next(now: Date) -> Step {
        if let firstUnreadEvent, let lastUnreadEvent {
            let readAt = min(lastUnreadEvent.addingTimeInterval(Self.debounce), firstUnreadEvent.addingTimeInterval(Self.pollInterval))
            if now >= readAt || now >= deadline { return .read }
            return .wait(until: min(readAt, deadline))
        }
        if appPostsNotifications {
            guard now < deadline else { return .finish }
            let quietEnd = lastActivity.addingTimeInterval(Self.quietWindow)
            guard now >= quietEnd else { return .wait(until: min(quietEnd, deadline)) }
            // Why: one read after the quiet window catches an app that changed without posting anything.
            if checkedQuiet { return .finish }
            checkedQuiet = true
            return .read
        }
        // Why: same beat as the old loop, which started a 200 ms sleep and a read whenever it was still under the ceiling.
        guard lastRead < deadline else { return .finish }
        let pollAt = lastRead.addingTimeInterval(Self.pollInterval)
        return now >= pollAt ? .read : .wait(until: pollAt)
    }
}

/// Per app, whether its accessibility notifications can be trusted to announce its changes.
public struct AccessibilityNotificationTrust: Equatable {
    public private(set) var postsNotifications = false
    private var changedSilently = false

    public init() {}

    /// A change was read; `announced` says whether a notification arrived since the read before it.
    public mutating func observedChange(announced: Bool) {
        if !announced {
            // Why: one silent change is enough to keep the full one-second polling for this app.
            changedSilently = true
        }
        postsNotifications = !changedSilently && (postsNotifications || announced)
    }
}
