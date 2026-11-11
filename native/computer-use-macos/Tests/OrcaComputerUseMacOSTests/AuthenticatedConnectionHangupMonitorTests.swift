import Darwin
import Dispatch
@testable import OrcaComputerUseMacOSCore
import XCTest

final class AuthenticatedConnectionHangupMonitorTests: XCTestCase {


    func testReportsPeerCloseWhileRequestHandlingIsBlocked() throws {
        let descriptors = try makeSocketPair()
        let hangup = expectation(description: "peer hangup")
        let processingStarted = expectation(description: "processing started")
        let releaseProcessing = DispatchSemaphore(value: 0)
        let processingFinished = DispatchSemaphore(value: 0)
        let monitor = try AuthenticatedConnectionHangupMonitor(
            fileDescriptor: descriptors.local,
            onHangup: {
                hangup.fulfill()
            }
        )
        monitor.start()

        DispatchQueue.global().async {
            processingStarted.fulfill()
            releaseProcessing.wait()
            processingFinished.signal()
        }
        wait(for: [processingStarted], timeout: 1)
        close(descriptors.peer)

        wait(for: [hangup], timeout: 1)
        XCTAssertEqual(processingFinished.wait(timeout: .now() + 0.05), .timedOut)

        releaseProcessing.signal()
        XCTAssertEqual(processingFinished.wait(timeout: .now() + 1), .success)
        monitor.cancel()
        close(descriptors.local)
    }



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
