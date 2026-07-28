import ExpoModulesCore

public class ExpoTerminalLiveInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoTerminalLiveInput")

    View(TerminalLiveInputView.self) {
      Events(
        "onEditorStateTransaction",
        "onInputFocus",
        "onInputBlur",
        "onKeyPress",
        "onTerminalEnter"
      )

      Prop("editable") { (view: TerminalLiveInputView, editable: Bool) in
        view.setEditable(editable)
      }

      AsyncFunction("focusAsync") { view in
        view.focusField()
      }

      AsyncFunction("blurAsync") { view in
        view.blurField()
      }

      AsyncFunction("setTextAsync") { (view, text: String) in
        view.setText(text)
      }
    }
  }
}
