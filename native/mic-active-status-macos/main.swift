// Prints whether the microphone is actively being captured and exits.
//
// Why this exists: Electron exposes no API for live CoreAudio input-stream
// state (only TCC permission status via systemPreferences.getMediaAccessStatus).
//
// Why the process-tap API (macOS 14.2+) rather than the default input
// device's DeviceIsRunningSomewhere: that device-wide property reports any
// active I/O on the device — including pure output playback through a
// duplex device (e.g. AirPods, a USB headset) — with no direction signal,
// so it can report "active" while nothing is recording. This queries each
// audio process for kAudioProcessPropertyIsRunningInput, the same
// direction-specific per-process signal that powers macOS's own per-app
// microphone indicator (Control Center, since macOS Sequoia).
//
// Falls back to the old device-wide heuristic on macOS < 14.2, where the
// process-tap properties don't exist; that fallback keeps the same
// direction-blind limitation there.
//
// Caveat that applies either way: this reflects whether the OS considers
// the mic stream open, not whether a specific app's in-app mute toggle
// (e.g. Zoom, Meet) is engaged — those typically keep the stream open and
// discard audio in software while "muted".
import CoreAudio
import Foundation

@available(macOS 14.2, *)
func anyProcessRunningInput() -> Bool? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var dataSize: UInt32 = 0
  var status = AudioObjectGetPropertyDataSize(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize
  )
  guard status == noErr, dataSize > 0 else { return nil }

  let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
  var processList = [AudioObjectID](repeating: AudioObjectID(kAudioObjectUnknown), count: count)
  status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &processList
  )
  guard status == noErr else { return nil }

  for processId in processList {
    var isRunningInput: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var inputAddress = AudioObjectPropertyAddress(
      mSelector: kAudioProcessPropertyIsRunningInput,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    let result = AudioObjectGetPropertyData(processId, &inputAddress, 0, nil, &size, &isRunningInput)
    if result == noErr, isRunningInput != 0 {
      return true
    }
  }
  return false
}

func defaultInputDevice() -> AudioDeviceID? {
  var deviceId = AudioDeviceID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceId
  )
  guard status == noErr, deviceId != kAudioObjectUnknown else { return nil }
  return deviceId
}

// Why device-wide, not direction-specific: pre-14.2 macOS has no per-process
// or per-direction "is running" property to query, so this is a best-effort
// fallback that shares the direction-blind limitation described above.
func isDeviceRunningAnyDirection(_ deviceId: AudioDeviceID) -> Bool? {
  var isRunning: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  let status = AudioObjectGetPropertyData(deviceId, &address, 0, nil, &size, &isRunning)
  guard status == noErr else { return nil }
  return isRunning != 0
}

func readMicActive() -> Bool? {
  if #available(macOS 14.2, *), let result = anyProcessRunningInput() {
    return result
  }
  if let deviceId = defaultInputDevice(), let running = isDeviceRunningAnyDirection(deviceId) {
    return running
  }
  return nil
}

if let micActive = readMicActive() {
  print("{\"micActive\":\(micActive)}")
} else {
  print("{\"micActive\":null}")
}
