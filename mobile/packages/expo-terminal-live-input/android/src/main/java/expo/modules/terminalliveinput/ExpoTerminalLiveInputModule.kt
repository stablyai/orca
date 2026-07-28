package expo.modules.terminalliveinput

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoTerminalLiveInputModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoTerminalLiveInput")

    View(TerminalLiveInputView::class) {
      Events(
        "onEditorStateTransaction",
        "onInputFocus",
        "onInputBlur",
        "onKeyPress",
        "onTerminalEnter"
      )

      Prop("editable") { view: TerminalLiveInputView, editable: Boolean ->
        view.setEditable(editable)
      }

      AsyncFunction("focusAsync") { view: TerminalLiveInputView ->
        return@AsyncFunction view.focusField()
      }

      AsyncFunction("blurAsync") { view: TerminalLiveInputView ->
        return@AsyncFunction view.blurField()
      }

      AsyncFunction("setTextAsync") { view: TerminalLiveInputView, text: String ->
        view.setText(text)
      }
    }
  }
}
