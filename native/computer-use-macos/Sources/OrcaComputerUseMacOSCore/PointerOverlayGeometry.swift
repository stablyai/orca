import CoreGraphics

public enum PointerOverlayGeometry {
    public static func windowOrigin(
        forQuartzPoint point: CGPoint,
        primaryDisplayMaxY: CGFloat,
        hotSpot: CGPoint
    ) -> CGPoint {
        CGPoint(
            x: point.x - hotSpot.x,
            y: primaryDisplayMaxY - point.y - hotSpot.y
        )
    }
}
