import CoreGraphics

var assertions = 0
func expect(_ actual: QuitChordDecision, _ expected: QuitChordDecision, _ label: String) {
  assertions += 1
  guard actual == expected else { fatalError("\(label): \(actual) != \(expected)") }
}
func sample(_ ms: UInt64, key: Bool = true, modifiers: CGEventFlags = .maskCommand,
            up: UInt32 = 10, flags: UInt32 = 20) -> QuitChordSample {
  QuitChordSample(keyDown: key, modifierFlags: modifiers, keyUpCount: up,
                  flagsCount: flags, now: ms * 1_000_000)
}

var hold = QuitChordWatch()
expect(hold.observe(sample(5000)), .watching, "ready begins native interval")
expect(hold.observe(sample(5999)), .watching, "999 ms is insufficient")
expect(hold.observe(sample(6000)), .held, "1000 ms completes continuous hold")
var beforeReady = QuitChordWatch()
expect(beforeReady.observe(sample(0, key: false)), .released, "tap released before helper starts")
var qRelease = QuitChordWatch()
expect(qRelease.observe(sample(0)), .watching, "Q release starts")
expect(qRelease.observe(sample(999, key: false)), .released, "Q release before deadline")
var commandRelease = QuitChordWatch()
expect(commandRelease.observe(sample(0)), .watching, "Command release starts")
expect(commandRelease.observe(sample(999, modifiers: [])), .released, "Command release before Q")
var capsLock = QuitChordWatch()
let commandWithCapsLock: CGEventFlags = [.maskCommand, .maskAlphaShift]
expect(capsLock.observe(sample(0, modifiers: commandWithCapsLock)), .watching, "Caps Lock is not a shortcut modifier")
expect(capsLock.observe(sample(1000, modifiers: commandWithCapsLock)), .held, "Command hold with Caps Lock")
for modifier: CGEventFlags in [.maskShift, .maskControl, .maskAlternate] {
  var extraModifier = QuitChordWatch()
  expect(extraModifier.observe(sample(0, modifiers: [.maskCommand, modifier])), .released,
         "an additional shortcut modifier prevents starting")
}
var fastQRepress = QuitChordWatch()
expect(fastQRepress.observe(sample(0)), .watching, "fast Q repress starts")
expect(fastQRepress.observe(sample(1000, up: 11)), .released, "release and repress between samples")
var fastCommandRepress = QuitChordWatch()
expect(fastCommandRepress.observe(sample(0)), .watching, "fast Command repress starts")
expect(fastCommandRepress.observe(sample(1000, flags: 22)), .released, "modifier release and repress")
var clockRegression = QuitChordWatch()
expect(clockRegression.observe(sample(100)), .watching, "clock starts")
expect(clockRegression.observe(sample(99)), .released, "clock regression fails closed")
var atDeadlineRelease = QuitChordWatch()
expect(atDeadlineRelease.observe(sample(0)), .watching, "deadline release starts")
expect(atDeadlineRelease.observe(sample(1000, key: false)), .released, "release wins over deadline")
print("QuitChordWatch: \(assertions) assertions passed")
