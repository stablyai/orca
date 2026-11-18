import CoreGraphics
import Darwin
import Foundation

/// Which windows belong to a Space. Minimized, hidden and other-Space windows do; a closed window an app keeps around does not.
public enum WindowSpaces {
    /// Nil when SkyLight's lookup is missing, so closed windows can't be told apart from other-Space ones.
    public static func windowsInAnySpace(_ windowIDs: [CGWindowID]) -> Set<CGWindowID>? {
        guard let symbols else { return nil }
        let connection = symbols.mainConnection()
        return Set(windowIDs.filter { windowID in
            let spaces = symbols.copySpacesForWindows(connection, allSpacesMask, [NSNumber(value: windowID)] as CFArray)?
                .takeRetainedValue() as? [NSNumber]
            return spaces?.isEmpty == false
        })
    }

    private static let allSpacesMask: Int32 = 0x7

    private typealias MainConnectionID = @convention(c) () -> Int32
    private typealias CopySpacesForWindows = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?

    private struct Symbols {
        let mainConnection: MainConnectionID
        let copySpacesForWindows: CopySpacesForWindows
    }

    private static let symbols: Symbols? = {
        let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
        guard let main = dlsym(skyLight, "SLSMainConnectionID"),
              let copy = dlsym(skyLight, "SLSCopySpacesForWindows")
        else { return nil }
        // SAFETY: SkyLight exports CGSConnectionID SLSMainConnectionID(void) and
        // CFArrayRef SLSCopySpacesForWindows(CGSConnectionID, CGSSpaceMask, CFArrayRef), returning a +1 array (as yabai uses them).
        return Symbols(
            mainConnection: unsafeBitCast(main, to: MainConnectionID.self),
            copySpacesForWindows: unsafeBitCast(copy, to: CopySpacesForWindows.self)
        )
    }()
}
