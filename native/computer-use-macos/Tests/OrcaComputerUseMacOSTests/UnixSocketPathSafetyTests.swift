import Darwin
import XCTest
@testable import OrcaComputerUseMacOSCore

final class UnixSocketPathSafetyTests: XCTestCase {
    func testOnlyUnixSocketModesAreAccepted() {
        XCTAssertTrue(UnixSocketPathSafety.isSocketMode(mode_t(S_IFSOCK | 0o600)))
        XCTAssertFalse(UnixSocketPathSafety.isSocketMode(mode_t(S_IFREG | 0o600)))
        XCTAssertFalse(UnixSocketPathSafety.isSocketMode(mode_t(S_IFDIR | 0o700)))
        XCTAssertFalse(UnixSocketPathSafety.isSocketMode(mode_t(S_IFLNK | 0o777)))
    }

    func testRejectsOnlyNonSocketPathsAfterAddressInUseBindFailure() {
        XCTAssertTrue(
            UnixSocketPathSafety.shouldRejectExistingPathAfterBindFailure(
                bindErrno: EADDRINUSE,
                existingMode: mode_t(S_IFREG | 0o600)
            )
        )
        XCTAssertFalse(
            UnixSocketPathSafety.shouldRejectExistingPathAfterBindFailure(
                bindErrno: EADDRINUSE,
                existingMode: mode_t(S_IFSOCK | 0o600)
            )
        )
        XCTAssertFalse(
            UnixSocketPathSafety.shouldRejectExistingPathAfterBindFailure(
                bindErrno: EACCES,
                existingMode: mode_t(S_IFREG | 0o600)
            )
        )
        XCTAssertFalse(
            UnixSocketPathSafety.shouldRejectExistingPathAfterBindFailure(
                bindErrno: EADDRINUSE,
                existingMode: nil
            )
        )
    }
}
