import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { imeOwnsSubmit, noteImeCompositionChange } from '../ime/ime-submit-carry'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import {
  deriveTerminalLiveCommit,
  getTerminalLiveSpecialKeyDecision,
  type TerminalLiveReplacement
} from './terminal-live-text-commit'

export type TerminalLiveInputChangeEvent = {
  readonly nativeEvent: {
    readonly text: string
    readonly isComposing?: boolean
    readonly replacementText?: string
    readonly replacementRange?: TerminalLiveReplacement['replacementRange']
    readonly target?: number
  }
}

// `nativeEvent: object` so React Native's own TextInputSubmitEditingEvent stays assignable; the
// view tag it carries at runtime is not declared on React Native's shipped event data types.
export type TerminalLiveInputSubmitEvent = { readonly nativeEvent?: object }

type TerminalLiveInputKeyPressEvent = {
  readonly nativeEvent: {
    readonly key: string
  }
}

type TerminalLiveInputCommitOptions<TTabType extends string> = {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabType: TTabType | null | undefined
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly connected: boolean
  readonly liveInputRef: RefObject<Pick<TextInput, 'setNativeProps'> | null>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly platform: string
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

export type TerminalLiveAccessoryInputCommitResult =
  | { readonly kind: 'allow-raw' }
  | { readonly kind: 'suppress-raw' }

type TerminalLiveInputCommitHandlers = {
  readonly clearPendingLiveInputCommit: () => void
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly handleLiveInputAccessoryBytes: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly handleLiveInputChange: (event: TerminalLiveInputChangeEvent) => void
  readonly handleLiveInputKeyPress: (event: TerminalLiveInputKeyPressEvent) => void
  readonly handleLiveInputSubmit: (event?: TerminalLiveInputSubmitEvent) => void
}

export function useTerminalLiveInputCommit<TTabType extends string>({
  activeHandle,
  activeHandleRef,
  activeSessionTabType,
  activeSessionTabTypeRef,
  connected,
  liveInputRef,
  liveInputTerminalHandles,
  liveInputTerminalHandlesRef,
  platform,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLiveInputCommitOptions<TTabType>): TerminalLiveInputCommitHandlers {
  const committedTextRef = useRef('')
  const isComposingRef = useRef(false)
  const pendingSendRef = useRef<Promise<boolean> | null>(null)

  const waitForPendingSend = useCallback(
    (): Promise<boolean> => pendingSendRef.current ?? Promise.resolve(true),
    []
  )

  const queueSend = useCallback(
    (handle: string, bytes: string): Promise<boolean> => {
      const previousSend = pendingSendRef.current
      const send = (async () => {
        if (previousSend && !(await previousSend)) {
          return false
        }
        return sendLiveTerminalInputRef.current(handle, bytes)
      })().catch(() => false)
      pendingSendRef.current = send
      void send.then(() => {
        if (pendingSendRef.current === send) {
          pendingSendRef.current = null
        }
      })
      return send
    },
    [sendLiveTerminalInputRef]
  )

  const clearPendingLiveInputCommit = useCallback(() => {
    committedTextRef.current = ''
    isComposingRef.current = false
    setLiveInputCapture('')
    liveInputRef.current?.setNativeProps({ text: '' })
  }, [liveInputRef, setLiveInputCapture])

  useEffect(() => {
    if (!connected) {
      clearPendingLiveInputCommit()
    }
  }, [clearPendingLiveInputCommit, connected])

  useEffect(() => {
    if (
      !activeHandle ||
      (activeSessionTabType != null && activeSessionTabType !== 'terminal') ||
      !liveInputTerminalHandles.has(activeHandle)
    ) {
      clearPendingLiveInputCommit()
    }
  }, [activeHandle, activeSessionTabType, clearPendingLiveInputCommit, liveInputTerminalHandles])

  const handleLiveInputChange = useCallback(
    ({ nativeEvent }: TerminalLiveInputChangeEvent) => {
      noteImeCompositionChange(platform, nativeEvent.isComposing, nativeEvent.target)
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        clearPendingLiveInputCommit()
        return
      }
      setLiveInputCapture(nativeEvent.text)
      if (nativeEvent.isComposing === true) {
        isComposingRef.current = true
        return
      }
      if (
        nativeEvent.isComposing !== false ||
        typeof nativeEvent.replacementText !== 'string' ||
        !nativeEvent.replacementRange
      ) {
        isComposingRef.current = true
        return
      }

      const commit = deriveTerminalLiveCommit(committedTextRef.current, {
        text: nativeEvent.text,
        replacementText: nativeEvent.replacementText,
        replacementRange: nativeEvent.replacementRange
      })
      if (!commit) {
        isComposingRef.current = true
        return
      }
      isComposingRef.current = false
      committedTextRef.current = commit.committedText
      if (commit.payload.length > 0) {
        void queueSend(activeHandle, commit.payload)
      }
    },
    [
      activeHandle,
      clearPendingLiveInputCommit,
      liveInputTerminalHandles,
      platform,
      queueSend,
      setLiveInputCapture
    ]
  )

  const handleLiveInputKeyPress = useCallback(
    ({ nativeEvent: { key } }: TerminalLiveInputKeyPressEvent) => {
      if (!activeHandle || isComposingRef.current || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      const decision = getTerminalLiveSpecialKeyDecision(key, committedTextRef.current.length > 0)
      if (decision.kind === 'send') {
        clearPendingLiveInputCommit()
        void queueSend(activeHandle, decision.bytes)
      }
    },
    [activeHandle, clearPendingLiveInputCommit, liveInputTerminalHandles, queueSend]
  )

  const handleLiveInputAccessoryBytes = useCallback(
    async (_input: TerminalLiveAccessoryInput): Promise<TerminalLiveAccessoryInputCommitResult> => {
      if (!activeHandle) {
        return { kind: 'allow-raw' }
      }
      if (!liveInputTerminalHandles.has(activeHandle)) {
        return (await waitForPendingSend()) ? { kind: 'allow-raw' } : { kind: 'suppress-raw' }
      }
      if (isComposingRef.current) {
        return { kind: 'suppress-raw' }
      }
      clearPendingLiveInputCommit()
      return (await waitForPendingSend()) ? { kind: 'allow-raw' } : { kind: 'suppress-raw' }
    },
    [activeHandle, clearPendingLiveInputCommit, liveInputTerminalHandles, waitForPendingSend]
  )

  const flushPendingLiveInputBeforeExternalSend = useCallback(
    async (handle: string): Promise<boolean> => {
      if (
        isComposingRef.current ||
        handle !== activeHandleRef.current ||
        (activeSessionTabTypeRef.current != null &&
          activeSessionTabTypeRef.current !== 'terminal') ||
        !liveInputTerminalHandlesRef.current.has(handle)
      ) {
        return false
      }
      clearPendingLiveInputCommit()
      return waitForPendingSend()
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      clearPendingLiveInputCommit,
      liveInputTerminalHandlesRef,
      waitForPendingSend
    ]
  )

  const handleLiveInputSubmit = useCallback(
    (event?: TerminalLiveInputSubmitEvent) => {
      if (imeOwnsSubmit((event?.nativeEvent as { target?: number } | undefined)?.target)) {
        return
      }
      if (!activeHandle || isComposingRef.current || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      clearPendingLiveInputCommit()
      void queueSend(activeHandle, '\r')
    },
    [activeHandle, clearPendingLiveInputCommit, liveInputTerminalHandles, queueSend]
  )

  return {
    clearPendingLiveInputCommit,
    flushPendingLiveInputBeforeExternalSend,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSubmit
  }
}
