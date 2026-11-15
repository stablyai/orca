import Darwin
import Dispatch
@testable import OrcaComputerUseMacOSCore
import XCTest

final class AuthenticatedConnectionHangupMonitorTests: XCTestCase {






    func testStartReportsHangupQueuedAfterSuccessfulSetup() throws {
        let descriptors = try makeSocketPair()
        let hangup = expectation(description: "queued peer hangup")
        let monitor = try AuthenticatedConnectionHangupMonitor(
            fileDescriptor: descriptors.local,
            onHangup: {
                hangup.fulfill()
            }
        )

        close(descriptors.peer)
        monitor.start()

        wait(for: [hangup], timeout: 1)
        monitor.cancel()
        close(descriptors.local)
    }
}



private func makeSocketPair() throws -> (local: Int32, peer: Int32) {
    var descriptors: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
        throw POSIXError(.EIO)
    }
    return (descriptors[0], descriptors[1])
}
