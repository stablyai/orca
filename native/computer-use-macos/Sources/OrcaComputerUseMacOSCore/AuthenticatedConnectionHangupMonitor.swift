import Darwin
import Dispatch
import Foundation

public final class AuthenticatedConnectionHangupMonitor: @unchecked Sendable {
    typealias RegisterEvents = @Sendable (
        Int32,
        UnsafePointer<kevent>?,
        Int32
    ) -> POSIXErrorCode?
    typealias CloseDescriptor = @Sendable (Int32) -> Void

    private static let cancelEventIdentifier: UInt = 1

    private let closeDescriptor: CloseDescriptor
    private let eventQueue: DispatchQueue
    private let eventQueueDescriptor: Int32
    private let onEvent: @Sendable () -> Void
    private let stateLock = NSLock()
    private let onHangup: @Sendable () -> Void
    private var isCancelled = false
    private var didReportHangup = false
    private var isFinished = false
    private var isStarted = false

    public convenience init(
        fileDescriptor: Int32,
        queue: DispatchQueue = DispatchQueue(
            label: "com.stablyai.orca.computer-use-owner-hangup"
        ),
        onEvent: @escaping @Sendable () -> Void = {},
        onHangup: @escaping @Sendable () -> Void
    ) throws {
        try self.init(
            fileDescriptor: fileDescriptor,
            queue: queue,
            registerEvents: { descriptor, events, count in
                guard kevent(descriptor, events, count, nil, 0, nil) == 0 else {
                    return POSIXErrorCode(rawValue: errno) ?? .EIO
                }
                return nil
            },
            closeDescriptor: { descriptor in
                close(descriptor)
            },
            onEvent: onEvent,
            onHangup: onHangup
        )
    }

    init(
        fileDescriptor: Int32,
        queue: DispatchQueue = DispatchQueue(
            label: "com.stablyai.orca.computer-use-owner-hangup"
        ),
        registerEvents: RegisterEvents,
        closeDescriptor: @escaping CloseDescriptor,
        onEvent: @escaping @Sendable () -> Void = {},
        onHangup: @escaping @Sendable () -> Void
    ) throws {
        self.closeDescriptor = closeDescriptor
        eventQueue = queue
        self.onEvent = onEvent
        self.onHangup = onHangup
        let descriptor = kqueue()
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard fileDescriptor >= 0 else {
            closeDescriptor(descriptor)
            throw POSIXError(.EBADF)
        }
        eventQueueDescriptor = descriptor
        var registrations = [
            kevent(
                ident: UInt(fileDescriptor),
                filter: Int16(EVFILT_READ),
                flags: UInt16(EV_ADD | EV_CLEAR),
                fflags: UInt32(NOTE_LOWAT),
                data: Int.max,
                udata: nil
            ),
            kevent(
                ident: Self.cancelEventIdentifier,
                filter: Int16(EVFILT_USER),
                flags: UInt16(EV_ADD | EV_CLEAR),
                fflags: 0,
                data: 0,
                udata: nil
            )
        ]
        let registrationError = registrations.withUnsafeMutableBufferPointer { buffer in
            registerEvents(descriptor, buffer.baseAddress, Int32(buffer.count))
        }
        if let registrationError {
            isFinished = true
            closeDescriptor(descriptor)
            throw POSIXError(registrationError)
        }
    }

    deinit {
        cancel()
    }

    public func start() {
        stateLock.lock()
        guard !isStarted, !isCancelled, !isFinished else {
            stateLock.unlock()
            return
        }
        isStarted = true
        stateLock.unlock()
        eventQueue.async { [self] in
            waitForHangup()
        }
    }

    public func cancel() {
        stateLock.lock()
        guard !isFinished else {
            stateLock.unlock()
            return
        }
        isCancelled = true
        guard isStarted else {
            isFinished = true
            closeDescriptor(eventQueueDescriptor)
            stateLock.unlock()
            return
        }
        var event = kevent(
            ident: Self.cancelEventIdentifier,
            filter: Int16(EVFILT_USER),
            flags: 0,
            fflags: UInt32(NOTE_TRIGGER),
            data: 0,
            udata: nil
        )
        _ = kevent(eventQueueDescriptor, &event, 1, nil, 0, nil)
        stateLock.unlock()
    }

    private func waitForHangup() {
        defer { finish() }
        while true {
            var event = kevent()
            let result = kevent(eventQueueDescriptor, nil, 0, &event, 1, nil)
            if result < 0 && errno == EINTR {
                continue
            }
            guard result > 0 else { return }
            onEvent()
            if event.filter == Int16(EVFILT_USER) {
                return
            }
            if event.flags & UInt16(EV_EOF | EV_ERROR) != 0 {
                reportHangup()
                return
            }
        }
    }

    private func finish() {
        stateLock.lock()
        isFinished = true
        closeDescriptor(eventQueueDescriptor)
        stateLock.unlock()
    }

    private func reportHangup() {
        stateLock.lock()
        guard !isCancelled, !didReportHangup else {
            stateLock.unlock()
            return
        }
        didReportHangup = true
        stateLock.unlock()

        onHangup()
    }
}
