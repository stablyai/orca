import type { TerminalLiveInputFocusTarget } from './terminal-live-input'

export type TerminalLiveInputCaptureHandle = TerminalLiveInputFocusTarget & {
  readonly setNativeProps: (props: { text?: string }) => void
}
