import type { RefObject } from 'react'
import type { TextInput } from 'react-native'
import type { TerminalLiveInputSelection } from './terminal-live-text-commit'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import type { TerminalLiveAccessoryInputCommitResult } from './use-terminal-live-accessory-input-commit'

export type TerminalLiveInputKeyPressEvent = {
  readonly nativeEvent: {
    readonly key: string
  }
}

/** `isComposing` is the text system's marked-text range, forwarded by the pinned
 *  react-native patch on iOS; `onChangeText` would drop the payload entirely.
 *  Absent means the platform reports no range — not "not composing". */
export type TerminalLiveInputChangeEvent = {
  readonly nativeEvent: {
    readonly text: string
    readonly isComposing?: boolean
    readonly inputType?: string
  }
}

export type TerminalLiveInputSelectionChangeEvent = {
  readonly nativeEvent: {
    readonly selection: TerminalLiveInputSelection
    readonly text?: string
  }
}

export type TerminalLiveInputCommitOptions<TTabType extends string> = {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabType: TTabType | null | undefined
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly buildLivePasteText?: (handle: string, text: string) => string
  readonly connected: boolean
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

export type TerminalLiveInputCommitHandlers = {
  readonly clearPendingLiveInputCommit: () => void
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly getLiveInputInteractionGeneration: () => number
  readonly handleLiveInputAccessoryBytes: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly handleLiveInputChange: (event: TerminalLiveInputChangeEvent) => void
  readonly handleLiveInputKeyPress: (event: TerminalLiveInputKeyPressEvent) => void
  readonly handleLiveInputSelectionChange: (event: TerminalLiveInputSelectionChangeEvent) => void
  readonly handleLiveInputSubmit: () => Promise<boolean>
  readonly sendLiveInputClick: (handle: string, bytes: string) => Promise<boolean>
}
