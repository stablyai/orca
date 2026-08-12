import XCTest
@testable import OrcaComputerUseMacOSCore

final class SyntheticMouseClickDeliveryTests: XCTestCase {
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

    func testInterEventPauseIsNonZero() {
        // Unpaced posts race the window server and the mouseUp is dropped,
        // turning the click into a hover-only no-op (STA-3433).
        XCTAssertGreaterThan(SyntheticMouseClickDelivery.interEventPauseMicroseconds, 0)
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
                currentRecipient: { intruder },
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

    func testRecipientChangeAfterMouseUpStopsUntilStateIsVerified() throws {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        let intruder = SyntheticMouseClickDelivery.Recipient(ownerPID: 52, windowID: 202)
        var recipients = [target, intruder, target, target]
        var firstAttempt: [SyntheticMouseClickDelivery.Step] = []

        XCTAssertThrowsError(
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 1,
                target: target,
                currentRecipient: { recipients.removeFirst() },
                makeEvent: { $0 },
                post: { firstAttempt.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(expected: target, actual: intruder, deliveredPresses: 1)
            )
        }
        XCTAssertEqual(firstAttempt, [
            .move,
            .buttonDown(pressIndex: 1),
            .buttonUp(pressIndex: 1),
        ])

        var retry: [SyntheticMouseClickDelivery.Step] = []
        try SyntheticMouseClickDelivery.deliver(
            clickCount: 1,
            target: target,
            currentRecipient: { recipients.removeFirst() },
            makeEvent: { $0 },
            post: { retry.append($0) },
            pause: { _ in }
        )
        XCTAssertEqual(retry, [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)])
    }

    func testMouseUpPostsBeforeSecondRecipientCheck() throws {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var trace: [String] = []

        try SyntheticMouseClickDelivery.deliver(
            clickCount: 1,
            target: target,
            currentRecipient: {
                trace.append("recipient")
                return target
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
            pause: { _ in }
        )

        XCTAssertEqual(trace, ["move", "recipient", "down", "up", "recipient"])
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
                currentRecipient: { recipients.removeFirst() },
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

    func testMultiClickRevalidatesBeforeEveryPressAndAfterEveryRelease() throws {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var validationCount = 0
        var posted: [SyntheticMouseClickDelivery.Step] = []

        try SyntheticMouseClickDelivery.deliver(
            clickCount: 2,
            target: target,
            currentRecipient: {
                validationCount += 1
                return target
            },
            makeEvent: { $0 },
            post: { posted.append($0) },
            pause: { _ in }
        )

        XCTAssertEqual(validationCount, 4)
        XCTAssertEqual(posted, SyntheticMouseClickDelivery.steps(clickCount: 2))
    }

    func testButtonPairIsPreparedBeforeMouseDownPosts() {
        enum PreparationFailure: Error { case mouseUp }
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var posted: [SyntheticMouseClickDelivery.Step] = []

        XCTAssertThrowsError(try SyntheticMouseClickDelivery.deliver(
            clickCount: 1,
            target: target,
            currentRecipient: { target },
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
