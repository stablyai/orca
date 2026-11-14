import CoreGraphics
import Foundation

struct QuitChordSample {
  let keyDown: Bool
  let commandDown: Bool
  let keyUpCount: UInt32
  let flagsCount: UInt32
  let now: UInt64
}

enum QuitChordDecision: String {
  case watching, held, released
}

struct QuitChordWatch {
  private var first: QuitChordSample?

  mutating func observe(_ sample: QuitChordSample) -> QuitChordDecision {
    guard sample.keyDown, sample.commandDown else { return .released }
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

func watchQuitChord(keyCode: UInt16) {
  var watch = QuitChordWatch()
  var announced = false
  while true {
    let keyUps = CGEventSource.counterForEventType(.combinedSessionState, eventType: .keyUp)
    let flags = CGEventSource.counterForEventType(.combinedSessionState, eventType: .flagsChanged)
    let sample = QuitChordSample(
      keyDown: CGEventSource.keyState(.combinedSessionState, key: keyCode),
      commandDown: CGEventSource.keyState(.combinedSessionState, key: 55)
        || CGEventSource.keyState(.combinedSessionState, key: 54),
      keyUpCount: CGEventSource.counterForEventType(.combinedSessionState, eventType: .keyUp),
      flagsCount: CGEventSource.counterForEventType(.combinedSessionState, eventType: .flagsChanged),
      now: DispatchTime.now().uptimeNanoseconds
    )
    let decision = keyUps == sample.keyUpCount && flags == sample.flagsCount
      ? watch.observe(sample) : .released
    if decision != .watching || !announced {
      let data = Data("{\"state\":\"\(decision.rawValue)\"}\n".utf8)
      FileHandle.standardOutput.write(data)
      announced = true
    }
    if decision != .watching { return }
    Thread.sleep(forTimeInterval: 0.008)
  }
}
