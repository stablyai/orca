import ExpoModulesCore
import UIKit

public class OrcaAppIconModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaAppIcon")

    // UIApplication is main-thread only.
    AsyncFunction("supportsAlternateIcons") { () -> Bool in
      UIApplication.shared.supportsAlternateIcons
    }.runOnQueue(.main)

    AsyncFunction("getAlternateIconName") { () -> String? in
      UIApplication.shared.alternateIconName
    }.runOnQueue(.main)

    AsyncFunction("setAlternateIconName") { (name: String?, promise: Promise) in
      UIApplication.shared.setAlternateIconName(name) { error in
        if let error {
          promise.reject("ERR_APP_ICON", error.localizedDescription)
        } else {
          promise.resolve(nil)
        }
      }
    }.runOnQueue(.main)
  }
}
