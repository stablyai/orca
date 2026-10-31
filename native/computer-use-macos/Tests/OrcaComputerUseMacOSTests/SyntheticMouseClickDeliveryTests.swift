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

    func testScrollWaitsBeforeRecheckAndDragDoesNotRecheckAfterDown() throws {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        for drag in [false, true] {
            var trace: [String] = []
            let observe = {
                trace.append("recipient")
                return SyntheticMouseClickDelivery.RecipientObservation.focused(target)
            }
            let post = { (event: String) in trace.append(event) }
            let pause = { (_: UInt32) in trace.append("pause") }
            if drag {
                try SyntheticMouseClickDelivery.deliverDrag(
                    move: "move", down: "down", dragged: ["drag"], up: "up",
                    target: target, currentObservation: observe, post: post, pause: pause
                )
                XCTAssertEqual(trace, ["recipient", "move", "recipient", "down", "pause", "drag", "pause", "up"])
            } else {
                try SyntheticMouseClickDelivery.deliverScroll(
                    move: "move", wheel: "wheel", target: target,
                    currentObservation: observe, post: post, pause: pause
                )
                XCTAssertEqual(trace, ["recipient", "move", "pause", "recipient", "wheel"])
            }
        }
    }

    func testSingleClickPlanPairsDownAndUpAfterMove() {
        XCTAssertEqual(
            SyntheticMouseClickDelivery.steps(clickCount: 1),
            [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)]
        )
    }

    func testMultiClickPlanNumbersEachPressForClickState() {
        XCTAssertEqual(
            SyntheticMouseClickDelivery.steps(clickCount: 2),
            [
                .move,
                .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1),
                .buttonDown(pressIndex: 2), .buttonUp(pressIndex: 2),
            ]
        )
    }

    func testNonPositiveClickCountStillDeliversOnePress() {
        for count in [0, -3] {
            XCTAssertEqual(
                SyntheticMouseClickDelivery.steps(clickCount: count),
                [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)]
            )
        }
    }

    func testExcessiveClickCountIsCappedAtTripleClick() {
        XCTAssertEqual(
            SyntheticMouseClickDelivery.steps(clickCount: Int.max),
            [
                .move,
                .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1),
                .buttonDown(pressIndex: 2), .buttonUp(pressIndex: 2),
                .buttonDown(pressIndex: 3), .buttonUp(pressIndex: 3),
            ]
        )
    }

    func testClickStateMatchesPressIndexAndSkipsMove() {
        XCTAssertEqual(SyntheticMouseClickDelivery.clickState(for: .move), 0)
        XCTAssertEqual(SyntheticMouseClickDelivery.clickState(for: .buttonDown(pressIndex: 1)), 1)
        XCTAssertEqual(SyntheticMouseClickDelivery.clickState(for: .buttonUp(pressIndex: 2)), 2)
    }

    func testAmbiguousWindowFrameFallbackDoesNotSelectRecipient() {
        let candidates = [(windowID: 101, frame: 7), (windowID: 202, frame: 7)]

        XCTAssertNil(SyntheticMouseClickDelivery.uniqueWindowCandidate(
            from: candidates,
            matching: { $0.frame == 7 }
        ))
        XCTAssertNil(SyntheticMouseClickDelivery.uniqueWindowCandidate(
            from: candidates,
            matching: { $0.frame == 8 }
        ))
        XCTAssertEqual(
            SyntheticMouseClickDelivery.uniqueWindowCandidate(
                from: candidates,
                matching: { $0.windowID == 101 }
            )?.windowID,
            101
        )
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

    func testMouseUpPostsBeforeRecipientCheckForTheNextPress() throws {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var trace: [String] = []

        try SyntheticMouseClickDelivery.deliver(
            clickCount: 2,
            target: target,
            currentObservation: {
                trace.append("recipient")
                return .focused(target)
            },
            makeEvent: { $0 },
            post: {
                switch $0 {
                case .move:
                    trace.append("move")
                case .buttonDown:
                    trace.append("down")
                case .buttonUp:
                    trace.append("up")
                }
            },
            pause: { interval in
                XCTAssertGreaterThan(interval, 0)
                trace.append("pause")
            }
        )

        XCTAssertEqual(trace, [
            "move", "pause", "recipient", "down", "pause", "up", "recipient",
            "pause", "recipient", "down", "pause", "up", "recipient", "pause"
        ])
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
