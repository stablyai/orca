import { OrcaTerminalKeyCaptureView } from '../../modules/orca-terminal-key-capture/src'
import type { TerminalKeyCaptureProps } from './TerminalKeyCapture'

export function TerminalKeyCapture({
  children,
  style,
  onKey
}: TerminalKeyCaptureProps): React.JSX.Element {
  if (!OrcaTerminalKeyCaptureView) {
    return <>{children}</>
  }
  return (
    <OrcaTerminalKeyCaptureView style={style} onTerminalKey={(event) => onKey(event.nativeEvent)}>
      {children}
    </OrcaTerminalKeyCaptureView>
  )
}
