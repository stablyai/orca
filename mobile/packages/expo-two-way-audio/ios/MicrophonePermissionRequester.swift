import ExpoModulesCore
import AVFoundation

let microphoneKey = "NSMicrophoneUsageDescription"

class MicrophonePermissionRequester: NSObject, EXPermissionsRequester {
  let mediaType: AVMediaType = .audio

  static func permissionType() -> String {
    "microphone"
  }

  func getPermissions() -> [AnyHashable: Any] {
    let systemStatus = AVAudioSession.sharedInstance().recordPermission
    var status: EXPermissionStatus

    guard (Bundle.main.infoDictionary?["NSMicrophoneUsageDescription"]) != nil else {
      EXFatal(EXErrorWithMessage("""
        This app is missing NSMicrophoneUsageDescription, so audio services will fail.
        Add one of these keys to your bundle's Info.plist.
      """))
      return ["status": EXPermissionStatusDenied]
    }

    switch systemStatus {
    case .granted:
      status = EXPermissionStatusGranted
    case .denied:
      status = EXPermissionStatusDenied
    case .undetermined:
      status = EXPermissionStatusUndetermined
    @unknown default:
      status = EXPermissionStatusUndetermined
    }

    return [
      "status": status.rawValue
    ]
  }

  func requestPermissions(resolver resolve: @escaping EXPromiseResolveBlock, rejecter reject: EXPromiseRejectBlock) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission { _ in
        resolve(self.getPermissions())
      }
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission { _ in
        resolve(self.getPermissions())
      }
    }
  }
}