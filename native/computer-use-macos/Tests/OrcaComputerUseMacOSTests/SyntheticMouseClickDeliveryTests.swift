import XCTest
@testable import OrcaComputerUseMacOSCore

final class SyntheticMouseClickDeliveryTests: XCTestCase {
    func testScrollAndDragFenceTheOriginBeforeMoveAndBeforeMutation() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        let sibling = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 202)
        for drag in [false, true] {
            for loss in [SyntheticMouseClickDelivery.RecipientObservation.focused(sibling), .unavailable, .dismissed] {
                for afterMove in [false, true] {
                    var observations: [SyntheticMouseClickDelivery.RecipientObservation] = afterMove ? [.focused(target), loss] : [loss]
                    var posted: [String] = []
                    let observe = { observations.isEmpty ? .unavailable : observations.removeFirst() }
                    XCTAssertThrowsError(try {
                        if drag {
                            try SyntheticMouseClickDelivery.deliverDrag(
                                move: "move", down: "down", dragged: ["drag"], up: "up",
                                target: target, currentObservation: observe,
                                post: { posted.append($0) }, pause: { _ in }
                            )
                        } else {
                            try SyntheticMouseClickDelivery.deliverScroll(
                                move: "move", wheel: "wheel",
                                target: target, currentObservation: observe,
                                post: { posted.append($0) }, pause: { _ in }
                            )
                        }
                    }())
                    XCTAssertEqual(posted, afterMove ? ["move"] : [])
                }
            }
        }
    }

    func testRecipientChangeBeforeMouseDownPostsNoClickAndReportsBothWindows() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        let intruder = SyntheticMouseClickDelivery.Recipient(ownerPID: 52, windowID: 202)
        var posted: [SyntheticMouseClickDelivery.Step] = []

        XCTAssertThrowsError(
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 1,
                target: target,
                currentObservation: { .focused(intruder) },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(expected: target, actual: intruder, deliveredPresses: 0)
            )
        }
        XCTAssertEqual(posted, [.move])
    }

    func testFinalMouseUpMayDismissTheTargetWithoutFailingTheClick() throws {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var observations: [SyntheticMouseClickDelivery.RecipientObservation] = [.focused(target), .dismissed]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        try SyntheticMouseClickDelivery.deliver(
            clickCount: 1,
            target: target,
            currentObservation: { observations.removeFirst() },
            makeEvent: { $0 },
            post: { posted.append($0) },
            pause: { _ in }
        )

        XCTAssertEqual(posted, [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)])
    }

    func testFinalUnavailableObservationRemainsFailClosed() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var observations: [SyntheticMouseClickDelivery.RecipientObservation] = [.focused(target), .unavailable]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        XCTAssertThrowsError(
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 1,
                target: target,
                currentObservation: { observations.removeFirst() },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(expected: target, actual: nil, deliveredPresses: 1)
            )
        }
        XCTAssertEqual(posted, [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)])
    }

    func testFinalMouseUpRejectsADifferentFocusedRecipient() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        let intruder = SyntheticMouseClickDelivery.Recipient(ownerPID: 52, windowID: 202)
        var recipients: [SyntheticMouseClickDelivery.Recipient?] = [target, intruder]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        XCTAssertThrowsError(
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 1,
                target: target,
                currentObservation: {
                    recipients.removeFirst().map(SyntheticMouseClickDelivery.RecipientObservation.focused) ?? .dismissed
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(expected: target, actual: intruder, deliveredPresses: 1)
            )
        }
        XCTAssertEqual(posted, [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)])
    }

    func testRecipientChangeBeforeLaterPressReportsCompletedPresses() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        let intruder = SyntheticMouseClickDelivery.Recipient(ownerPID: 52, windowID: 202)
        var recipients = [target, target, intruder]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        XCTAssertThrowsError(
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 2,
                target: target,
                currentObservation: {
                    .focused(recipients.removeFirst())
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(expected: target, actual: intruder, deliveredPresses: 1)
            )
        }
        XCTAssertEqual(posted, [
            .move,
            .buttonDown(pressIndex: 1),
            .buttonUp(pressIndex: 1),
        ])
    }

    func testRecipientChangeAfterIntermediateMouseUpStopsBeforeNextPress() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        let intruder = SyntheticMouseClickDelivery.Recipient(ownerPID: 52, windowID: 202)
        var recipients: [SyntheticMouseClickDelivery.Recipient?] = [target, intruder]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        XCTAssertThrowsError(
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 2,
                target: target,
                currentObservation: {
                    recipients.removeFirst().map(SyntheticMouseClickDelivery.RecipientObservation.focused) ?? .dismissed
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(expected: target, actual: intruder, deliveredPresses: 1)
            )
        }
        XCTAssertEqual(posted, [
            .move,
            .buttonDown(pressIndex: 1),
            .buttonUp(pressIndex: 1),
        ])
    }

    func testIntermediateMouseUpDismissalStopsBeforeNextPress() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var recipients: [SyntheticMouseClickDelivery.Recipient?] = [target, nil]
        var posted: [SyntheticMouseClickDelivery.Step] = []

        XCTAssertThrowsError(
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 2,
                target: target,
                currentObservation: {
                    recipients.removeFirst().map(SyntheticMouseClickDelivery.RecipientObservation.focused) ?? .dismissed
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(expected: target, actual: nil, deliveredPresses: 1)
            )
        }
        XCTAssertEqual(posted, [
            .move,
            .buttonDown(pressIndex: 1),
            .buttonUp(pressIndex: 1),
        ])
    }

    func testButtonPairIsPreparedBeforeMouseDownPosts() {
        enum PreparationFailure: Error { case mouseUp }
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var posted: [SyntheticMouseClickDelivery.Step] = []

        XCTAssertThrowsError(try SyntheticMouseClickDelivery.deliver(
            clickCount: 1,
            target: target,
            currentObservation: { .focused(target) },
            makeEvent: { step in
                if case .buttonUp = step { throw PreparationFailure.mouseUp }
                return step
            },
            post: { posted.append($0) },
            pause: { _ in }
        ))
        XCTAssertEqual(posted, [.move])
    }
}
