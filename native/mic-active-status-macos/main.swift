// Prints whether the default input device is actively running and exits.
//
// Why this exists: Electron exposes no API for live CoreAudio device state
// (only TCC permission status via systemPreferences.getMediaAccessStatus).
// This reads kAudioDevicePropertyDeviceIsRunningSomewhere on the default
// input device — the same low-level signal that drives macOS's system
// microphone indicator. Note this reflects whether *some* process has an
// open input stream, not whether a specific app's in-app mute toggle (e.g.
// Zoom, Meet) is engaged — those typically keep the hardware stream open
// and discard audio in software while "muted".
import CoreAudio
import Foundation

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

func isDeviceRunning(_ deviceId: AudioDeviceID) -> Bool? {
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

if let deviceId = defaultInputDevice(), let running = isDeviceRunning(deviceId) {
  print("{\"micActive\":\(running)}")
} else {
  print("{\"micActive\":null}")
}
