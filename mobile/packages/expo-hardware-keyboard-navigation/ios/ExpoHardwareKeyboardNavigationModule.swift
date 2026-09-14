import ExpoModulesCore
import GameController
import ObjectiveC.runtime
import UIKit

private let hardwareKeyboardSelector = NSSelectorFromString("handleOrcaHardwareKeyboardCommand:")

struct HardwareKeyboardCommandRecord: Record {
  @Field var actionId: String = ""
  @Field var key: String = ""
  @Field var control: Bool = false
  @Field var meta: Bool = false
  @Field var alt: Bool = false
  @Field var shift: Bool = false
}

@MainActor
private final class HardwareKeyboardCommandRegistry {
  static let shared = HardwareKeyboardCommandRegistry()

  private weak var controller: UIViewController?
  private var commandPayloads: [ObjectIdentifier: [String: String]] = [:]
  private var installedCommands: [UIKeyCommand] = []
  var handler: (([String: String]) -> Void)?

  func install(_ records: [HardwareKeyboardCommandRecord]) {
    guard let controller = rootViewController() else { return }
    if self.controller !== controller {
      uninstall()
      self.controller = controller
    }
    addHandlerMethod(to: type(of: controller))
    installedCommands.forEach(controller.removeKeyCommand)
    commandPayloads.removeAll()
    installedCommands = records.compactMap(makeCommand)
    installedCommands.forEach(controller.addKeyCommand)
  }

  func handle(_ command: UIKeyCommand) {
    guard let payload = commandPayloads[ObjectIdentifier(command)] else { return }
    handler?(payload)
  }

  private func uninstall() {
    if let controller {
      installedCommands.forEach(controller.removeKeyCommand)
    }
    installedCommands.removeAll()
    commandPayloads.removeAll()
  }

  private func makeCommand(_ record: HardwareKeyboardCommandRecord) -> UIKeyCommand? {
    guard let input = keyInput(record.key) else { return nil }
    var modifiers: UIKeyModifierFlags = []
    if record.control { modifiers.insert(.control) }
    if record.meta { modifiers.insert(.command) }
    if record.alt { modifiers.insert(.alternate) }
    if record.shift { modifiers.insert(.shift) }
    let command = UIKeyCommand(input: input, modifierFlags: modifiers, action: hardwareKeyboardSelector)
    command.wantsPriorityOverSystemBehavior = true
    command.allowsAutomaticLocalization = false
    command.allowsAutomaticMirroring = false
    commandPayloads[ObjectIdentifier(command)] = ["actionId": record.actionId, "key": record.key]
    return command
  }

  private func keyInput(_ key: String) -> String? {
    if key.count == 1 { return key.lowercased() }
    return switch key {
    case "ArrowUp": UIKeyCommand.inputUpArrow
    case "ArrowDown": UIKeyCommand.inputDownArrow
    case "ArrowLeft": UIKeyCommand.inputLeftArrow
    case "ArrowRight": UIKeyCommand.inputRightArrow
    case "BracketLeft": "["
    case "BracketRight": "]"
    case "PageUp": UIKeyCommand.inputPageUp
    case "PageDown": UIKeyCommand.inputPageDown
    case "Tab": "\t"
    default: nil
    }
  }

  private func rootViewController() -> UIViewController? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)?
      .rootViewController
  }

  private func addHandlerMethod(to controllerClass: AnyClass) {
    guard class_getInstanceMethod(controllerClass, hardwareKeyboardSelector) == nil else { return }
    typealias HandlerBlock = @convention(block) (AnyObject, UIKeyCommand) -> Void
    let block: HandlerBlock = { _, command in
      Task { @MainActor in HardwareKeyboardCommandRegistry.shared.handle(command) }
    }
    class_addMethod(
      controllerClass,
      hardwareKeyboardSelector,
      imp_implementationWithBlock(block),
      "v@:@"
    )
  }
}

public final class ExpoHardwareKeyboardNavigationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoHardwareKeyboardNavigation")
    Events("onHardwareKeyboardCommand")

    Function("setCommands") { (records: [HardwareKeyboardCommandRecord]) in
      DispatchQueue.main.async {
        HardwareKeyboardCommandRegistry.shared.install(records)
      }
    }

    Function("isHardwareKeyboardConnected") {
      if #available(iOS 14.0, *) {
        return GCKeyboard.coalesced != nil
      }
      return false
    }

    OnStartObserving("onHardwareKeyboardCommand") {
      DispatchQueue.main.async {
        HardwareKeyboardCommandRegistry.shared.handler = { [weak self] payload in
          self?.sendEvent("onHardwareKeyboardCommand", payload)
        }
      }
    }

    OnStopObserving("onHardwareKeyboardCommand") {
      DispatchQueue.main.async {
        HardwareKeyboardCommandRegistry.shared.handler = nil
      }
    }
  }
}
