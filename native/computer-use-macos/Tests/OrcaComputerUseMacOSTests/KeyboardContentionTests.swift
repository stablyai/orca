import CoreFoundation
import XCTest
@testable import OrcaComputerUseMacOSCore

final class KeyboardContentionTests: XCTestCase {
    private let target: pid_t = 4242
    private let idle = KeyboardContention.Conditions(
        secureInputEnabled: false,
        secureInputOwnerPID: nil,
        secondsSinceUserKeyDown: 30,
        secondsSinceOwnInput: nil
    )

    private func refusal(
        _ conditions: KeyboardContention.Conditions,
        sharesUserKeyboard: Bool = true,
        sendsKeys: Bool = true
    ) -> KeyboardContention.Refusal? {
        KeyboardContention.refusal(targetPID: target, sharesUserKeyboard: sharesUserKeyboard, sendsKeys: sendsKeys, conditions: conditions)
    }

    func testIdleUserAndNoSecureInputAllowEveryInput() {
        XCTAssertNil(refusal(idle))
        XCTAssertNil(refusal(idle, sendsKeys: false))
        XCTAssertNil(refusal(idle, sharesUserKeyboard: false))
    }

    func testRecentUserKeyPressRefusesInputThatSharesTheirKeyboard() {
        var typing = idle
        typing.secondsSinceUserKeyDown = 0.4
        XCTAssertEqual(refusal(typing), .userTyping(secondsAgo: 0.4))
        XCTAssertEqual(refusal(typing, sendsKeys: false), .userTyping(secondsAgo: 0.4))
        typing.secondsSinceUserKeyDown = KeyboardContention.userTypingQuietPeriod
        XCTAssertNil(refusal(typing))
    }

    func testUserTypingElsewhereDoesNotBlockBackgroundInputToAnInactiveApp() {
        var typing = idle
        typing.secondsSinceUserKeyDown = 0.1
        XCTAssertNil(refusal(typing, sharesUserKeyboard: false))
        XCTAssertNil(refusal(typing, sharesUserKeyboard: false, sendsKeys: false))
    }

    func testTheHelpersOwnLatestKeysDoNotCountAsTheUsers() {
        var afterOwnKeys = idle
        afterOwnKeys.secondsSinceUserKeyDown = 0.3
        afterOwnKeys.secondsSinceOwnInput = 0.3
        XCTAssertNil(refusal(afterOwnKeys))
        // A key press that came after the helper's own input is the user's.
        afterOwnKeys.secondsSinceUserKeyDown = 0.1
        XCTAssertEqual(refusal(afterOwnKeys), .userTyping(secondsAgo: 0.1))
        // A key press well before the helper's own input is the user's too, while it is still recent.
        afterOwnKeys.secondsSinceUserKeyDown = 1.3
        XCTAssertEqual(refusal(afterOwnKeys), .userTyping(secondsAgo: 1.3))
        // The helper's last key down lands just before it records the input.
        afterOwnKeys.secondsSinceUserKeyDown = 0.32
        XCTAssertNil(refusal(afterOwnKeys))
    }

    func testSecureInputRefusesKeysThatShareTheUsersKeyboard() {
        var secure = idle
        secure.secureInputEnabled = true
        secure.secureInputOwnerPID = 99
        XCTAssertEqual(refusal(secure), .secureInputActive(ownerPID: 99))
        secure.secureInputOwnerPID = nil
        XCTAssertEqual(refusal(secure), .secureInputActive(ownerPID: nil))
    }

    func testSecureInputInTheTargetRefusesEvenBackgroundKeys() {
        var secure = idle
        secure.secureInputEnabled = true
        secure.secureInputOwnerPID = target
        XCTAssertEqual(refusal(secure, sharesUserKeyboard: false), .secureInputActive(ownerPID: target))
    }

    func testSecureInputInAnotherAppLeavesBackgroundKeysAndClicksAlone() {
        var secure = idle
        secure.secureInputEnabled = true
        secure.secureInputOwnerPID = 99
        XCTAssertNil(refusal(secure, sharesUserKeyboard: false))
        XCTAssertNil(refusal(secure, sendsKeys: false))
    }

    func testSecureInputOwnerComesFromTheSessionDictionary() {
        XCTAssertEqual(KeyboardContention.secureInputOwnerPID(session: [KeyboardContention.secureInputPIDKey: NSNumber(value: 321)]), 321)
        XCTAssertNil(KeyboardContention.secureInputOwnerPID(session: [KeyboardContention.secureInputPIDKey: NSNumber(value: 0)]))
        XCTAssertNil(KeyboardContention.secureInputOwnerPID(session: [:]))
        XCTAssertNil(KeyboardContention.secureInputOwnerPID(session: nil))
    }

    func testOwnInputClockMeasuresFromTheLastRecordedInput() {
        var now: CFAbsoluteTime = 1_000
        let clock = KeyboardContention.OwnInputClock(now: { now })
        XCTAssertNil(clock.secondsSinceLastInput())
        clock.recordInput()
        now += 1.25
        XCTAssertEqual(clock.secondsSinceLastInput(), 1.25)
    }
}
