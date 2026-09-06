export type TerminalLiveInputKeyPressEvent = {
  readonly nativeEvent: { readonly key: string }
}

/** Absent isComposing means the text system did not report a marked-text range. */
export type TerminalLiveInputChangeEvent = {
  readonly nativeEvent: {
    readonly text: string
    readonly isComposing?: boolean
    readonly eventCount?: number
    readonly target?: number
  }
}
