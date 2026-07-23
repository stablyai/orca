export type TerminalLiveInputCaptureHandle = {
  readonly focus: () => void
  readonly blur: () => void
  readonly isFocused: () => boolean
  readonly setNativeProps: (props: { readonly text?: string }) => void
}
