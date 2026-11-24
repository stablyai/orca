// Electron lacks UNUserNotificationCenter authorization status; successful scheduling can still be suppressed.
// Run inside the app bundle (NSBundle walks up from the executable) and sign/embed Info.plist with
// its CFBundleIdentifier: macOS keys notification settings to the signing identifier.
import Foundation
import UserNotifications

let semaphore = DispatchSemaphore(value: 0)
var authorization = "unknown"
var alert = "unknown"
UNUserNotificationCenter.current().getNotificationSettings { settings in
  switch settings.authorizationStatus {
  case .authorized: authorization = "authorized"
  case .provisional: authorization = "provisional"
  case .ephemeral: authorization = "ephemeral"
  case .denied: authorization = "denied"
  case .notDetermined: authorization = "not-determined"
  @unknown default: authorization = "unknown"
  }
  switch settings.alertSetting {
  case .enabled: alert = "enabled"
  case .disabled: alert = "disabled"
  case .notSupported: alert = "not-supported"
  @unknown default: alert = "unknown"
  }
  semaphore.signal()
}
_ = semaphore.wait(timeout: .now() + 3)
print("{\"authorization\":\"\(authorization)\",\"alert\":\"\(alert)\"}")
