// Prints {"micActive":bool|null}: whether any process has an open mic stream.
// Uses per-process IsRunningInput (macOS 14.2+), since the device-wide flag also fires for output-only playback on duplex devices.
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

// Pre-14.2 fallback; direction-blind.
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
