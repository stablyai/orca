import Foundation

/// The condition `orca computer wait --text/--enabled` waits for, checked against each read of the target.
///
/// Mirrors the CLI's check in src/cli/computer/computer-wait.ts, which still verifies the snapshot it gets back:
/// an element matches when its first tree line, without the index, contains the value (case-insensitive).
/// `--enabled` holds when something matches and none of the matches is disabled.
public struct AccessibilityWaitCondition: Equatable {
    public enum Kind: String {
        case text
        case enabled
    }

    public let kind: Kind
    public let value: String

    public init?(kind: String, value: String) {
        guard let kind = Kind(rawValue: kind) else { return nil }
        self.kind = kind
        self.value = value
    }

    public func holds(treeText: String, disabledIndexes: Set<Int>) -> Bool {
        let needle = value.lowercased()
        let matches = Self.elementLines(treeText).filter { needle.isEmpty || $0.text.lowercased().contains(needle) }
        guard !matches.isEmpty else { return false }
        return kind == .text || matches.allSatisfy { !disabledIndexes.contains($0.index) }
    }

    /// Element lines are `<tabs><index>` followed by a space or the end of the line, as the CLI parses them.
    static func elementLines(_ treeText: String) -> [(index: Int, text: String)] {
        treeText.split(separator: "\n", omittingEmptySubsequences: false).compactMap { line in
            let body = line.drop { $0 == "\t" }
            let digits = body.prefix { $0.isASCII && $0.isNumber }
            guard !digits.isEmpty, let index = Int(digits) else { return nil }
            var rest = body.dropFirst(digits.count)
            if let first = rest.first {
                guard first == " " else { return nil }
                rest = rest.dropFirst()
            }
            return (index, String(rest))
        }
    }
}

/// Decides when a helper-side wait re-reads the target.
///
/// A read follows each burst of accessibility notifications from the app. Apps that have shown they announce their
/// changes are otherwise left alone, apart from a slow safety read; every other app keeps the CLI's 250 ms beat,
/// so a change that posts nothing is still caught as soon as the old polling would have caught it.
public struct AccessibilityWaitPlan: Equatable {
    /// The beat `orca computer wait` polled at from the CLI.
    public static let pollInterval: TimeInterval = 0.25
    /// Safety read for apps that announce their changes, in case one change does not.
    public static let notifyingAppPollInterval: TimeInterval = 1
    public static let debounce = AccessibilitySettlePlan.debounce
    /// A nonstop stream of notifications is still read this soon after its first unread one.
    public static let maxEventDelay = AccessibilitySettlePlan.pollInterval

    public enum Step: Equatable {
        case wait(until: Date)
        case read
        case finish
    }

    public let deadline: Date
    public var appPostsNotifications: Bool
    private var lastRead: Date?
    private var firstUnreadEvent: Date?
    private var lastUnreadEvent: Date?

    public init(deadline: Date, appPostsNotifications: Bool) {
        self.deadline = deadline
        self.appPostsNotifications = appPostsNotifications
    }

    public var hasUnreadEvent: Bool { lastUnreadEvent != nil }

    public mutating func eventArrived(at time: Date) {
        if firstUnreadEvent == nil { firstUnreadEvent = time }
        lastUnreadEvent = time
    }

    public mutating func didRead(at time: Date) {
        lastRead = time
        firstUnreadEvent = nil
        lastUnreadEvent = nil
    }

    public mutating func next(now: Date) -> Step {
        guard let lastRead else { return .read }
        if let firstUnreadEvent, let lastUnreadEvent {
            let readAt = min(lastUnreadEvent.addingTimeInterval(Self.debounce), firstUnreadEvent.addingTimeInterval(Self.maxEventDelay))
            // Why: a notification that came in before the deadline still gets its read.
            if now >= readAt || now >= deadline { return .read }
            return .wait(until: min(readAt, deadline))
        }
        guard now < deadline else { return .finish }
        let interval = appPostsNotifications ? Self.notifyingAppPollInterval : Self.pollInterval
        let pollAt = lastRead.addingTimeInterval(interval)
        return now >= pollAt ? .read : .wait(until: min(pollAt, deadline))
    }
}
