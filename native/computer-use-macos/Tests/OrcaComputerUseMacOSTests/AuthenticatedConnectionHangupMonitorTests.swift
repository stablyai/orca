import Darwin
import Dispatch
@testable import OrcaComputerUseMacOSCore
import XCTest

final class AuthenticatedConnectionHangupMonitorTests: XCTestCase {
    func testRejectsInvalidDescriptorDuringSetup() {
        XCTAssertThrowsError(
            try AuthenticatedConnectionHangupMonitor(
                fileDescriptor: -1,
                onHangup: {}
            )
        )
    }

    func testRegistrationFailureClosesEventQueueOnce() {
        let closes = DescriptorCloseRecorder()

        XCTAssertThrowsError(
            try AuthenticatedConnectionHangupMonitor(
                fileDescriptor: 42,
                registerEvents: { _, _, _ in .EBADF },
                closeDescriptor: { descriptor in
                    closes.recordAndClose(descriptor)
                },
                onHangup: {}
            )
        )
        XCTAssertEqual(closes.count, 1)
    }

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

    func testReadableDataDoesNotLookLikeHangup() throws {
        let descriptors = try makeSocketPair()
        let hangup = expectation(description: "peer hangup")
        let callbacks = CallbackRecorder()
        let events = CallbackRecorder()
        let monitor = try AuthenticatedConnectionHangupMonitor(
            fileDescriptor: descriptors.local,
            onEvent: {
                events.record()
            },
            onHangup: {
                callbacks.record()
                hangup.fulfill()
            }
        )
        monitor.start()
        var byte: UInt8 = 7

        XCTAssertEqual(write(descriptors.peer, &byte, 1), 1)
        usleep(50_000)
        XCTAssertEqual(callbacks.count, 0)
        XCTAssertEqual(events.count, 0)
        close(descriptors.peer)
        wait(for: [hangup], timeout: 1)
        XCTAssertEqual(events.count, 1)

        monitor.cancel()
        close(descriptors.local)
    }

    func testCancelPreventsLaterHangupCallback() throws {
        let descriptors = try makeSocketPair()
        let hangup = expectation(description: "peer hangup")
        hangup.isInverted = true
        let monitor = try AuthenticatedConnectionHangupMonitor(
            fileDescriptor: descriptors.local,
            onHangup: {
                hangup.fulfill()
            }
        )
        monitor.start()

        monitor.cancel()
        close(descriptors.peer)

        wait(for: [hangup], timeout: 0.1)
        close(descriptors.local)
    }

    func testCancelReleasesMonitorWhileSocketStaysOpen() throws {
        let descriptors = try makeSocketPair()
        var monitor: AuthenticatedConnectionHangupMonitor? = try AuthenticatedConnectionHangupMonitor(
            fileDescriptor: descriptors.local,
            onHangup: {}
        )
        weak var retainedMonitor = monitor

        monitor?.cancel()
        monitor = nil

        let deadline = Date().addingTimeInterval(1)
        while retainedMonitor != nil, Date() < deadline {
            usleep(10_000)
        }
        XCTAssertNil(retainedMonitor)
        close(descriptors.peer)
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

private final class CallbackRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedCount = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return recordedCount
    }

    func record() {
        lock.lock()
        recordedCount += 1
        lock.unlock()
    }
}

private final class DescriptorCloseRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var closeCount = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return closeCount
    }

    func recordAndClose(_ descriptor: Int32) {
        lock.lock()
        closeCount += 1
        let shouldClose = closeCount == 1
        lock.unlock()
        if shouldClose {
            close(descriptor)
        }
    }
}

private func makeSocketPair() throws -> (local: Int32, peer: Int32) {
    var descriptors: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
        throw POSIXError(.EIO)
    }
    return (descriptors[0], descriptors[1])
}
