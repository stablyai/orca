import { useEffect, useRef, useState } from 'react'
import {
  dialogShowParamsSchema,
  type BridgeDialogAnswer,
  type BridgeDialogShowParams
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-dialog-verb'
import { useShellDialogs } from './shell-dialogs'

type Untokened<T> = T extends unknown ? Omit<T, 'token'> : never

export type ShellDialogRequest = Untokened<BridgeDialogShowParams>

type Mode = 'native' | 'drawn'

let tokenSeed = 0

function nextToken(): string {
  tokenSeed += 1
  return `${Date.now().toString(36)}-${tokenSeed}`
}

// Decided once per opening: a dialog that changes while the shell shows it keeps what it opened with, as a UIKit alert does.
function openingMode(
  canShow: boolean,
  request: ShellDialogRequest | null,
  visible: boolean
): Mode {
  if (!visible || !canShow || request === null) {
    return 'drawn'
  }
  return dialogShowParamsSchema.safeParse({ ...request, token: '-' }).success ? 'native' : 'drawn'
}

/**
 * True while the shell presents this dialog natively, so the caller draws nothing. `request` is
 * null when the dialog holds something only the drawn one can show; a refused request draws too.
 */
export function useShellDialog(args: {
  visible: boolean
  request: ShellDialogRequest | null
  onAnswer: (answer: BridgeDialogAnswer) => void
  // The caller closed it while the shell showed it, where the drawn one would call onAfterClose.
  onWithdrawn?: () => void
}): boolean {
  const dialogs = useShellDialogs()
  const latest = useRef(args)
  useEffect(() => {
    latest.current = args
  })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [opening, setOpening] = useState<{ visible: boolean; mode: Mode }>({
    visible: false,
    mode: 'drawn'
  })
  if (opening.visible !== args.visible) {
    setOpening({
      visible: args.visible,
      mode: openingMode(dialogs !== null, args.request, args.visible)
    })
  }
  const native = args.visible && opening.mode === 'native'

  useEffect(() => {
    const request = latest.current.request
    if (!native || dialogs === null || request === null) {
      return
    }
    const token = nextToken()
    let pending = true
    dialogs.show({ ...request, token }).then(
      (answer) => {
        if (pending) {
          pending = false
          latest.current.onAnswer(answer)
        }
      },
      () => {
        if (pending) {
          pending = false
          setOpening((current) => (current.visible ? { ...current, mode: 'drawn' } : current))
        }
      }
    )
    return () => {
      if (!pending) {
        return
      }
      pending = false
      void dialogs.dismiss(token).catch(() => {})
      if (mounted.current) {
        latest.current.onWithdrawn?.()
      }
    }
  }, [dialogs, native])

  return native
}
