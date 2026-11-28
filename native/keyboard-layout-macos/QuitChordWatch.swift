import CoreGraphics
import Foundation

struct QuitChordSample {
  let keyDown: Bool
  let modifierFlags: CGEventFlags
  let keyUpCount: UInt32
  let flagsCount: UInt32
  let now: UInt64
}

enum QuitChordDecision: String {
  case watching, held, released
}

struct QuitChordWatch {
  private static let shortcutModifiers: CGEventFlags = [.maskCommand, .maskShift, .maskControl, .maskAlternate]
  private var first: QuitChordSample?

  mutating func observe(_ sample: QuitChordSample) -> QuitChordDecision {
    guard sample.keyDown,
          sample.modifierFlags.intersection(Self.shortcutModifiers) == .maskCommand else {
      return .released
    }
    guard let first else {
      self.first = sample
      return .watching
    }
    guard sample.now >= first.now,
          sample.keyUpCount == first.keyUpCount,
          sample.flagsCount == first.flagsCount else { return .released }
    return sample.now - first.now >= 1_000_000_000 ? .held : .watching
  }
}

func runQuitChordWatch(
  sample: (CGEventSourceStateID) -> QuitChordSample?,
  wait: () -> Void,
  emit: (QuitChordDecision) -> Void
) {
  for source: CGEventSourceStateID in [.hidSystemState, .combinedSessionState] {
    var watch = QuitChordWatch()
    guard let first = sample(source), watch.observe(first) == .watching else { continue }
    emit(.watching)

    // A release in the source that armed the gesture must never be masked by another source.
    while true {
      wait()
      let decision = sample(source).map { watch.observe($0) } ?? .released
      if decision != .watching {
        emit(decision)
        return
      }
    }
  }
  emit(.released)
}

private func readQuitChord(keyCode: UInt16, source: CGEventSourceStateID) -> QuitChordSample? {
  let keyUps = CGEventSource.counterForEventType(source, eventType: .keyUp)
  let flags = CGEventSource.counterForEventType(source, eventType: .flagsChanged)
  let sample = QuitChordSample(
    keyDown: CGEventSource.keyState(source, key: keyCode),
    modifierFlags: CGEventSource.flagsState(source),
    keyUpCount: CGEventSource.counterForEventType(source, eventType: .keyUp),
    flagsCount: CGEventSource.counterForEventType(source, eventType: .flagsChanged),
    now: DispatchTime.now().uptimeNanoseconds
  )
  return keyUps == sample.keyUpCount && flags == sample.flagsCount ? sample : nil
}

func watchQuitChord(keyCode: UInt16) {
  runQuitChordWatch(
    sample: { readQuitChord(keyCode: keyCode, source: $0) },
    wait: { Thread.sleep(forTimeInterval: 0.008) },
    emit: { decision in
      let data = Data("{\"state\":\"\(decision.rawValue)\"}\n".utf8)
      FileHandle.standardOutput.write(data)
    }
  )
}
