import { OrcaTerminalKeyCaptureView } from '../../modules/orca-terminal-key-capture/src'
import type { TerminalHardwareKeyCaptureProps } from './TerminalHardwareKeyCapture'

/**
 * Hands Ctrl/Alt chords, Esc, Tab, arrows, Home/End, PageUp/PageDown and F-keys from hardware
 * keyboards and keyboard apps to the terminal. Android's TextInput reports none of them to
 * `onKeyPress`, so the native parent takes them before the field can drop them or edit with them.
 */
export function TerminalHardwareKeyCapture({
  style,
  onTerminalKey,
  children
}: TerminalHardwareKeyCaptureProps) {
  return (
    <OrcaTerminalKeyCaptureView style={style} onTerminalKey={onTerminalKey}>
      {children}
    </OrcaTerminalKeyCaptureView>
  )
}
