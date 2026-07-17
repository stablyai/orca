import CoreAudio
import Darwin
import Foundation

enum HelperError: Error, CustomStringConvertible {
    case invalidArguments(String)
    case coreAudio(String, OSStatus)
    case unsupported(String)

    var description: String {
        switch self {
        case let .invalidArguments(message), let .unsupported(message): return message
        case let .coreAudio(operation, status): return "\(operation) failed with OSStatus \(status)."
        }
    }
}

func readUInt32(_ object: AudioObjectID, _ address: inout AudioObjectPropertyAddress) throws -> UInt32 {
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
    guard status == noErr else { throw HelperError.coreAudio("Read Core Audio property", status) }
    return value
}

func defaultOutputDevice() throws -> AudioDeviceID {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let device = try readUInt32(AudioObjectID(kAudioObjectSystemObject), &address)
    guard device != kAudioObjectUnknown else { throw HelperError.unsupported("No default output device is available.") }
    return device
}

func deviceUID(_ device: AudioDeviceID) throws -> String {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: CFString?
    var size = UInt32(MemoryLayout<CFString?>.size)
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value)
    guard status == noErr else { throw HelperError.coreAudio("Read output device UID", status) }
    guard let value else { throw HelperError.unsupported("The output device has no stable UID.") }
    return value as String
}

func muteAddress() -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
}

func readMute(_ device: AudioDeviceID) throws -> Bool {
    var address = muteAddress()
    guard AudioObjectHasProperty(device, &address) else {
        throw HelperError.unsupported("The default output device does not expose a mute control.")
    }
    let value = try readUInt32(device, &address)
    return value != 0
}

func setMute(_ muted: Bool, device: AudioDeviceID) throws {
    var address = muteAddress()
    var settable = DarwinBoolean(false)
    let settableStatus = AudioObjectIsPropertySettable(device, &address, &settable)
    guard settableStatus == noErr else { throw HelperError.coreAudio("Inspect output mute control", settableStatus) }
    guard settable.boolValue else { throw HelperError.unsupported("The output device mute control is read-only.") }
    var value: UInt32 = muted ? 1 : 0
    let status = AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &value)
    guard status == noErr else { throw HelperError.coreAudio("Set output mute", status) }
    guard try readMute(device) == muted else {
        throw HelperError.unsupported("The output device did not accept the requested mute state.")
    }
}

func argument(_ name: String, in args: [String]) throws -> String {
    guard let index = args.firstIndex(of: name), args.indices.contains(index + 1) else {
        throw HelperError.invalidArguments("Missing \(name).")
    }
    return args[index + 1]
}

func printSnapshot() throws {
    let device = try defaultOutputDevice()
    let payload: [String: Any] = [
        "endpointId": try deviceUID(device),
        "endpointTarget": String(device),
        "muted": try readMute(device),
    ]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [])
    print(String(decoding: data, as: UTF8.self))
}

func applyMute(_ args: [String]) throws {
    let expectedUID = try argument("--endpoint-id", in: args)
    guard let target = AudioDeviceID(try argument("--endpoint-target", in: args)) else {
        throw HelperError.invalidArguments("Invalid --endpoint-target.")
    }
    guard try deviceUID(target) == expectedUID else {
        throw HelperError.unsupported("The captured output device is no longer available.")
    }
    guard let muted = Bool(args.last ?? "") else { throw HelperError.invalidArguments("Invalid mute state.") }
    try setMute(muted, device: target)
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    switch args.first {
    case "snapshot": try printSnapshot()
    case "set-muted": try applyMute(args)
    default: throw HelperError.invalidArguments("Usage: orca-playback-suppression snapshot | set-muted --endpoint-id ID --endpoint-target TARGET true|false")
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
