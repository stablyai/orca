public struct ScreenCaptureProbeWindow: Equatable {
    public let layer: Int
    public let ownerPid: Int32
    public let windowId: UInt32

    public init(layer: Int, ownerPid: Int32, windowId: UInt32) {
        self.layer = layer
        self.ownerPid = ownerPid
        self.windowId = windowId
    }
}

public enum ScreenCaptureProbeWindowSelection {
    public static func firstCrossProcessNormalWindow(
        ownPid: Int32,
        windows: [ScreenCaptureProbeWindow]
    ) -> UInt32? {
        windows.first { window in
            window.layer == 0 && window.ownerPid != ownPid
        }?.windowId
    }
}
