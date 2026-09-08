type TerminalLiveInputNativeTextTarget = {
  readonly setNativeProps?: (props: { readonly text: string }) => void
}

export function setTerminalLiveInputNativeText(
  target: TerminalLiveInputNativeTextTarget | null,
  text: string
): void {
  target?.setNativeProps?.({ text })
}
