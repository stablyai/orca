import { useEffect, useEffectEvent, useRef, useSyncExternalStore, type ReactElement } from 'react'
import { Alert, type AlertButton, type AlertOptions } from 'react-native'
import type {
  MobileWebNativeAlertPayload,
  MobileWebNativeAlertResult
} from '../../../src/shared/mobile-web/native-operation-contract'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { ConfirmModal } from '../components/ConfirmModal'

type MobileWebAlertTarget = {
  alert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions): void
}

export type MobileWebAlertPrompt = {
  id: number
  title: string
  message?: string
  buttons: AlertButton[]
  options?: AlertOptions
  presentation: 'unattempted' | 'native' | 'fallback'
}

export type MobileWebAlertController = {
  alert: MobileWebAlertTarget['alert']
  beginNativePresentation: (id: number) => boolean
  choose: (id: number, button?: AlertButton, dismissed?: boolean) => void
  getSnapshot: () => MobileWebAlertPrompt | null
  subscribe: (listener: () => void) => () => void
  useFallbackPresentation: (id: number) => void
}

export type MobileWebNativeAlertPresenter = (
  payload: MobileWebNativeAlertPayload
) => Promise<MobileWebNativeAlertResult>

const installedTargets = new WeakSet<object>()
const MOBILE_WEB_ALERT_QUEUE_LIMIT = 16

export function createMobileWebAlertController(): MobileWebAlertController {
  const listeners = new Set<() => void>()
  const pending: MobileWebAlertPrompt[] = []
  let active: MobileWebAlertPrompt | null = null
  let nextId = 1

  const publish = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  const alert: MobileWebAlertTarget['alert'] = (title, message, buttons, options) => {
    const prompt = {
      id: nextId++,
      title,
      message,
      buttons: buttons?.length ? buttons : [{ text: 'OK' }],
      options,
      presentation: 'unattempted' as const
    }
    if (active) {
      if (pending.length >= MOBILE_WEB_ALERT_QUEUE_LIMIT - 1) {
        return
      }
      pending.push(prompt)
      return
    }
    active = prompt
    publish()
  }
  const choose = (id: number, button?: AlertButton, dismissed = button === undefined): void => {
    if (active?.id !== id) {
      return
    }
    const completed = active
    try {
      if (button) {
        button.onPress?.()
      } else if (dismissed) {
        completed.options?.onDismiss?.()
      }
    } finally {
      active = pending.shift() ?? null
      publish()
    }
  }

  return {
    alert,
    beginNativePresentation(id) {
      if (active?.id !== id || active.presentation !== 'unattempted') {
        return false
      }
      active = { ...active, presentation: 'native' }
      publish()
      return true
    },
    choose,
    getSnapshot: () => active,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    useFallbackPresentation(id) {
      if (active?.id === id && active.presentation !== 'fallback') {
        active = { ...active, presentation: 'fallback' }
        publish()
      }
    }
  }
}

const hostedAlertController = createMobileWebAlertController()

export function installMobileWebAlertAdapter(target: MobileWebAlertTarget = Alert): boolean {
  if (installedTargets.has(target)) {
    return false
  }
  target.alert = hostedAlertController.alert
  installedTargets.add(target)
  return true
}

export function MobileWebAlertAdapter({
  presentNative
}: {
  presentNative?: MobileWebNativeAlertPresenter
}): ReactElement | null {
  const prompt = useSyncExternalStore(
    hostedAlertController.subscribe,
    hostedAlertController.getSnapshot,
    hostedAlertController.getSnapshot
  )
  const chosenPromptRef = useRef<number | null>(null)
  const presentNativeEvent = useEffectEvent((payload: MobileWebNativeAlertPayload) =>
    presentNative?.(payload)
  )

  useEffect(() => {
    const current = hostedAlertController.getSnapshot()
    if (!current || !hostedAlertController.beginNativePresentation(current.id)) {
      return
    }
    const presentation = presentNativeEvent(nativeAlertPayload(current))
    if (!presentation) {
      hostedAlertController.useFallbackPresentation(current.id)
      return
    }
    void presentation
      .then((result) => {
        if (result.kind === 'button') {
          hostedAlertController.choose(current.id, current.buttons[result.buttonIndex], false)
        } else {
          hostedAlertController.choose(current.id)
        }
      })
      .catch(() => {
        hostedAlertController.useFallbackPresentation(current.id)
      })
  }, [prompt?.id])

  if (!prompt) {
    return null
  }
  if (prompt.presentation !== 'fallback') {
    return null
  }

  const choose = (button?: AlertButton): void => {
    if (chosenPromptRef.current === prompt.id) {
      return
    }
    chosenPromptRef.current = prompt.id
    hostedAlertController.choose(prompt.id, button)
    queueMicrotask(() => {
      if (chosenPromptRef.current === prompt.id) {
        chosenPromptRef.current = null
      }
    })
  }
  const dismissible =
    prompt.options?.cancelable === true && globalThis.navigator?.userAgent.includes('Android')
  if (prompt.buttons.length > 2) {
    return (
      <ActionSheetModal
        visible
        title={prompt.title}
        message={prompt.message}
        dismissible={dismissible}
        actions={prompt.buttons.map((button) => ({
          label: button.text ?? 'OK',
          destructive: button.style === 'destructive',
          onPress: () => choose(button)
        }))}
        onClose={() => choose()}
      />
    )
  }

  const cancelButton =
    prompt.buttons.length === 2
      ? (prompt.buttons.find((button) => button.style === 'cancel') ?? prompt.buttons[0])
      : undefined
  const confirmButton = prompt.buttons.find((button) => button !== cancelButton)
  return (
    <ConfirmModal
      visible
      title={prompt.title}
      message={prompt.message}
      cancelLabel={cancelButton?.text ?? null}
      confirmLabel={confirmButton?.text ?? 'OK'}
      destructive={confirmButton?.style === 'destructive'}
      dismissible={dismissible}
      onConfirm={() => choose(confirmButton)}
      onCancel={() => choose(cancelButton)}
      onDismiss={() => choose()}
    />
  )
}

function nativeAlertPayload(prompt: MobileWebAlertPrompt): MobileWebNativeAlertPayload {
  return {
    title: prompt.title,
    ...(prompt.message === undefined ? {} : { message: prompt.message }),
    buttons: prompt.buttons.map(({ text, style, isPreferred }) => ({
      ...(text === undefined ? {} : { text }),
      ...(style === undefined ? {} : { style }),
      ...(isPreferred === undefined ? {} : { isPreferred })
    })),
    ...(prompt.options
      ? {
          options: {
            ...(prompt.options.cancelable === undefined
              ? {}
              : { cancelable: prompt.options.cancelable }),
            ...(prompt.options.userInterfaceStyle === undefined
              ? {}
              : { userInterfaceStyle: prompt.options.userInterfaceStyle })
          }
        }
      : {})
  }
}
