import CoreGraphics

public enum PointerMotionPath {
    public static func points(from start: CGPoint, to end: CGPoint, steps: Int) -> [CGPoint] {
        guard steps > 0 else { return [end] }

        return (1...steps).map { step in
            let progress = CGFloat(step) / CGFloat(steps)
            return CGPoint(
                x: start.x + (end.x - start.x) * progress,
                y: start.y + (end.y - start.y) * progress
            )
        }
    }
}
