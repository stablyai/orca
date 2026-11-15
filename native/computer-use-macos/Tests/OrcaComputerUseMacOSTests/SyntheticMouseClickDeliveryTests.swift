import XCTest
@testable import OrcaComputerUseMacOSCore

final class SyntheticMouseClickDeliveryTests: XCTestCase {
    private let target = SyntheticMouseClickDelivery.Recipient(ownerPID: 41, windowID: 101)
    private let beneath = SyntheticMouseClickDelivery.Recipient(ownerPID: 52, windowID: 202)

    private func clickUnfocusedTarget(afterUp: SyntheticMouseClickDelivery.RecipientObservation, targetOnScreenAfterUp: Bool) throws -> [SyntheticMouseClickDelivery.Step] {
        var observations = [(SyntheticMouseClickDelivery.RecipientObservation.focused(target), true), (afterUp, targetOnScreenAfterUp)]
        var posted: [SyntheticMouseClickDelivery.Step] = []
        try SyntheticMouseClickDelivery.deliver(
            clickCount: 1,
            target: target,
            currentObservation: {
                let (hit, onScreen) = observations.removeFirst()
                return SyntheticMouseClickDelivery.topmostObservation(hit: hit, target: target, targetOnScreen: onScreen)
            },
            makeEvent: { $0 },
            post: { posted.append($0) },
            pause: { _ in }
        )
        return posted
    }

    func testAClickThatClosesAnUnfocusedTargetSucceeds() throws {
        XCTAssertEqual(
            try clickUnfocusedTarget(afterUp: .focused(beneath), targetOnScreenAfterUp: false),
            [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)]
        )
    }

    func testAnotherWindowOverAnUnfocusedTargetStillFailsTheFence() {
        XCTAssertThrowsError(try clickUnfocusedTarget(afterUp: .focused(beneath), targetOnScreenAfterUp: true)) { error in
            XCTAssertEqual(
                error as? SyntheticMouseClickDelivery.FenceFailure,
                .recipientChanged(expected: target, actual: beneath, deliveredPresses: 1)
            )
        }
    }
}
