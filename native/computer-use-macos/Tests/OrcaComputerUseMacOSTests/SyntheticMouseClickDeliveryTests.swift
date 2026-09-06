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
                currentObservation: { _ in .focused(intruder) },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(expected: target, actual: intruder, deliveredPresses: 0, phase: .beforePress)
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
            currentObservation: { _ in observations.removeFirst() },
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
                currentObservation: { _ in observations.removeFirst() },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(
                    expected: target,
                    actual: nil,
                    deliveredPresses: 1,
                    phase: .afterPress
                )
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
                currentObservation: { _ in
                    recipients.removeFirst().map(SyntheticMouseClickDelivery.RecipientObservation.focused) ?? .dismissed
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(
                    expected: target,
                    actual: intruder,
                    deliveredPresses: 1,
                    phase: .afterPress
                )
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
            currentObservation: { _ in
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
            pause: { _ in }
        )

        XCTAssertEqual(trace, [
            "move", "recipient", "down", "up", "recipient", "recipient", "down", "up", "recipient"
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
                currentObservation: { _ in
                    .focused(recipients.removeFirst())
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(
                    expected: target,
                    actual: intruder,
                    deliveredPresses: 1,
                    phase: .beforePress
                )
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
                currentObservation: { _ in
                    recipients.removeFirst().map(SyntheticMouseClickDelivery.RecipientObservation.focused) ?? .dismissed
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(
                    expected: target,
                    actual: intruder,
                    deliveredPresses: 1,
                    phase: .afterPress
                )
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
                currentObservation: { _ in
                    recipients.removeFirst().map(SyntheticMouseClickDelivery.RecipientObservation.focused) ?? .dismissed
                },
                makeEvent: { $0 },
                post: { posted.append($0) },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(
                    expected: target,
                    actual: nil,
                    deliveredPresses: 1,
                    phase: .afterPress
                )
            )
        }
        XCTAssertEqual(posted, [
            .move,
            .buttonDown(pressIndex: 1),
            .buttonUp(pressIndex: 1),
        ])
    }

    func testMultiClickRevalidatesBeforeEveryPressAndBetweenReleases() throws {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var samples: [SyntheticMouseClickDelivery.FenceSample] = []
        var posted: [SyntheticMouseClickDelivery.Step] = []

        try SyntheticMouseClickDelivery.deliver(
            clickCount: 2,
            target: target,
            currentObservation: { sample in
                samples.append(sample)
                return .focused(target)
            },
            makeEvent: { $0 },
            post: { posted.append($0) },
            pause: { _ in }
        )

        XCTAssertEqual(samples, [
            .beforePress(pressIndex: 1),
            .afterRelease(pressIndex: 1),
            .beforePress(pressIndex: 2),
            .afterRelease(pressIndex: 2),
        ])
        XCTAssertEqual(posted, SyntheticMouseClickDelivery.steps(clickCount: 2))
    }

    func testButtonPairIsPreparedBeforeMouseDownPosts() {
        enum PreparationFailure: Error { case mouseUp }
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var posted: [SyntheticMouseClickDelivery.Step] = []

        XCTAssertThrowsError(try SyntheticMouseClickDelivery.deliver(
            clickCount: 1,
            target: target,
            currentObservation: { _ in .focused(target) },
            makeEvent: { step in
                if case .buttonUp = step { throw PreparationFailure.mouseUp }
                return step
            },
            post: { posted.append($0) },
            pause: { _ in }
        ))
        XCTAssertEqual(posted, [.move])
    }

    func testEqualDeliveredPressesDistinguishBeforePressFromAfterPress() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        let intruder = SyntheticMouseClickDelivery.Recipient(ownerPID: 52, windowID: 202)

        var afterUpObservations: [SyntheticMouseClickDelivery.RecipientObservation] = [
            .focused(target),
            .focused(intruder),
        ]
        XCTAssertThrowsError(
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 1,
                target: target,
                currentObservation: { _ in afterUpObservations.removeFirst() },
                makeEvent: { $0 },
                post: { _ in },
                pause: { _ in }
            )
        ) { error in
            XCTAssertEqual(
                (error as? SyntheticMouseClickDelivery.FenceFailure)?.phase,
                .afterPress
            )
        }

        var beforePressObservations: [SyntheticMouseClickDelivery.RecipientObservation] = [
            .focused(target),
            .focused(target),
            .focused(intruder),
        ]
        XCTAssertThrowsError(
            try SyntheticMouseClickDelivery.deliver(
                clickCount: 2,
                target: target,
                currentObservation: { _ in beforePressObservations.removeFirst() },
                makeEvent: { $0 },
                post: { _ in },
                pause: { _ in }
            )
        ) { error in
            let failure = error as? SyntheticMouseClickDelivery.FenceFailure
            XCTAssertEqual(failure?.deliveredPresses, 1)
            XCTAssertEqual(failure?.phase, .beforePress)
        }
    }

    func testRecoveryIsAllowedOnlyBeforeTheFirstPress() {
        XCTAssertTrue(
            SyntheticMouseClickDelivery.FenceSample.beforePress(pressIndex: 1).allowsRecovery
        )
        XCTAssertFalse(
            SyntheticMouseClickDelivery.FenceSample.beforePress(pressIndex: 2).allowsRecovery
        )
        XCTAssertFalse(
            SyntheticMouseClickDelivery.FenceSample.afterRelease(pressIndex: 1).allowsRecovery
        )
    }

    func testSettledObservationResolvesAfterTransientUnavailableProbes() {
        let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
        var probes = 0
        var pauses: [UInt32] = []

        let observation = SyntheticMouseClickDelivery.settledObservation(
            attempts: 4,
            interProbePauseMicroseconds: 100_000,
            currentObservation: {
                probes += 1
                return probes >= 3 ? .focused(target) : .unavailable
            },
            shouldRetry: { $0 == .unavailable },
            pause: { pauses.append($0) }
        )

        XCTAssertEqual(observation, .focused(target))
        XCTAssertEqual(probes, 3)
        XCTAssertEqual(pauses, [100_000, 100_000])
    }

    func testSettledObservationGivesUpAfterBoundedAttempts() {
        var probes = 0
        var pauses: [UInt32] = []

        let observation = SyntheticMouseClickDelivery.settledObservation(
            attempts: 3,
            interProbePauseMicroseconds: 50,
            currentObservation: {
                probes += 1
                return .unavailable
            },
            shouldRetry: { $0 == .unavailable },
            pause: { pauses.append($0) }
        )

        XCTAssertEqual(observation, .unavailable)
        XCTAssertEqual(probes, 3)
        XCTAssertEqual(pauses, [50, 50])
    }

    func testSettledObservationDoesNotRetryDefinitiveDismissal() {
        var probes = 0
        var pauses: [UInt32] = []

        let observation = SyntheticMouseClickDelivery.settledObservation(
            attempts: 4,
            interProbePauseMicroseconds: 50,
            currentObservation: {
                probes += 1
                return .dismissed
            },
            shouldRetry: { $0 == .unavailable },
            pause: { pauses.append($0) }
        )

        XCTAssertEqual(observation, .dismissed)
        XCTAssertEqual(probes, 1)
        XCTAssertEqual(pauses, [])
    }
}
