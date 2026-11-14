import OrcaComputerUseMacOSCore
import XCTest

final class SessionLockProbeTests: XCTestCase {
    func testTheSessionLockFlagDecides() {
        XCTAssertTrue(SessionLockProbe.isLocked(session: ["CGSSessionScreenIsLocked": kCFBooleanTrue as Any]))
        XCTAssertTrue(SessionLockProbe.isLocked(session: ["CGSSessionScreenIsLocked": NSNumber(value: 1)]))
        XCTAssertFalse(SessionLockProbe.isLocked(session: ["CGSSessionScreenIsLocked": kCFBooleanFalse as Any]))
    }

    func testAnAbsentKeyOrMissingSessionIsUnlocked() {
        XCTAssertFalse(SessionLockProbe.isLocked(session: ["kCGSSessionOnConsoleKey": NSNumber(value: 1)]))
        XCTAssertFalse(SessionLockProbe.isLocked(session: nil))
    }
}
