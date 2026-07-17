import CoreGraphics

public struct PointerMotionPlan: Equatable {
    public let points: [CGPoint]
    public let delayMicroseconds: UInt32

    public init(points: [CGPoint], delayMicroseconds: UInt32) {
        self.points = points
        self.delayMicroseconds = delayMicroseconds
    }
}

public enum PointerMotionPolicy {
    public static let approachSteps = 12
    public static let approachDelayMicroseconds: UInt32 = 8_000
    public static let dragSteps = 10
    public static let dragDelayMicroseconds: UInt32 = 12_000

    public static func approachPlan(
        from start: CGPoint,
        to end: CGPoint,
        reduceMotion: Bool
    ) -> PointerMotionPlan {
        if reduceMotion {
            return PointerMotionPlan(points: [end], delayMicroseconds: 0)
        }
        return PointerMotionPlan(
            points: PointerMotionPath.points(from: start, to: end, steps: approachSteps),
            delayMicroseconds: approachDelayMicroseconds
        )
    }

    public static func dragPlan(
        from start: CGPoint,
        to end: CGPoint,
        reduceMotion: Bool
    ) -> PointerMotionPlan {
        if reduceMotion {
            return PointerMotionPlan(points: [end], delayMicroseconds: 0)
        }
        return PointerMotionPlan(
            points: PointerMotionPath.points(from: start, to: end, steps: dragSteps),
            delayMicroseconds: dragDelayMicroseconds
        )
    }
}
