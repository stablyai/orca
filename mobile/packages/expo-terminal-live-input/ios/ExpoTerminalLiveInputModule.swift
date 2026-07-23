import ExpoModulesCore

public class ExpoTerminalLiveInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoTerminalLiveInput")

    View(TerminalLiveInputView.self) {
      Events("onCommittedText", "onInputFocus", "onInputBlur", "onKeyPress", "onTerminalEnter")

      Prop("editable") { (view: TerminalLiveInputView, editable: Bool) in
        view.setEditable(editable)
      }

      AsyncFunction("focusAsync") { (view: TerminalLiveInputView) in
        return view.focusField()
      }

      AsyncFunction("blurAsync") { (view: TerminalLiveInputView) in
        return view.blurField()
      }

      AsyncFunction("setTextAsync") { (view: TerminalLiveInputView, text: String) in
        view.setText(text)
      }

    }
  }
}
