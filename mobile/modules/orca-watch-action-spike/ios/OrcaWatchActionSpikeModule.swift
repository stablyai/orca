import ExpoModulesCore
import UIKit

public class OrcaWatchActionSpikeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaWatchActionSpike")

    AsyncFunction("readEvents") { () -> [[String: Any]] in
      WatchActionSpikeLedger.shared.events()
    }

    AsyncFunction("clearEvents") {
      WatchActionSpikeLedger.shared.clear()
    }

    AsyncFunction("endHold") {
      WatchActionSpikeResponseObserver.shared.endHold(reason: "js-done")
    }

    AsyncFunction("isProtectedDataAvailable") { () -> Bool in
      UIApplication.shared.isProtectedDataAvailable
    }.runOnQueue(.main)
  }
}
