import Foundation

public enum ComputerSnapshotCachePolicy {
    public static let maxEntries = 32
    public static let maxAge: TimeInterval = 2 * 60

    public static func isExpired(createdAt: Date, now: Date = Date()) -> Bool {
        now.timeIntervalSince(createdAt) > maxAge
    }

    public static func shouldPrune(entryCount: Int, createdAt: Date, now: Date = Date()) -> Bool {
        entryCount > maxEntries || isExpired(createdAt: createdAt, now: now)
    }
}
