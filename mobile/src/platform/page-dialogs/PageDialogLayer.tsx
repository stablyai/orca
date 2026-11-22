import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useFocusEffect, useNavigation } from 'expo-router'
import { ConfirmModal } from '../../components/sheets/ConfirmModal'
import { TextInputModal } from '../../components/sheets/TextInputModal'
import { NativeSinglePicker } from '../../components/sheets/NativeSinglePicker'
import { groupPickerSections } from '../../components/sheets/picker-options'
import type { BridgeDialogShowParams } from '../../mobile-web-shell/bridge/native-capabilities/bridge-dialog-verb'
import { createPageDialogQueue, type PageDialogQueue } from './page-dialog-queue'

// A replaced document or a covered screen must not leave its dialog up or its request pending.
export function usePageDialogs(sessionId: string | null): PageDialogQueue {
  const navigation = useNavigation()
  const queue = useMemo(
    () => createPageDialogQueue({ isFocused: navigation.isFocused }),
    [navigation, sessionId]
  )
  useEffect(() => () => queue.dismissAll(), [queue])
  useFocusEffect(useCallback(() => () => queue.dismissAll(), [queue]))
  return queue
}

/** Presents the page's pending dialog with the app's own native alert, prompt and picker. */
export function PageDialogLayer({ queue }: { queue: PageDialogQueue }) {
  const request = useSyncExternalStore(queue.subscribe, queue.current)
  if (request === null) {
    return null
  }
  return <PageDialog key={request.token} queue={queue} request={request} />
}

function PageDialog({
  queue,
  request
}: {
  queue: PageDialogQueue
  request: BridgeDialogShowParams
}) {
  const { token } = request
  const pressed = useRef<'confirm' | 'cancel' | null>(null)
  const picked = useRef<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(true)

  switch (request.action) {
    case 'confirm':
      return (
        <ConfirmModal
          visible
          title={request.title}
          message={request.message}
          confirmLabel={request.confirmLabel}
          cancelLabel={request.cancelLabel}
          destructive={request.destructive}
          onConfirm={() => {
            pressed.current = 'confirm'
          }}
          onCancelPress={() => {
            pressed.current = 'cancel'
          }}
          onCancel={() => queue.answer(token, pressed.current ?? 'dismiss')}
        />
      )
    case 'prompt':
      return (
        <TextInputModal
          visible
          title={request.title}
          message={request.message}
          defaultValue={request.defaultValue}
          placeholder={request.placeholder}
          submitLabel={request.submitLabel}
          cancelLabel={request.cancelLabel}
          selectTextOnFocus={request.selectTextOnFocus}
          allowEmpty={request.allowEmpty}
          keyboardType={request.keyboardType}
          onSubmit={(value) => queue.answer(token, 'confirm', value)}
          onCancel={() => queue.answer(token, 'cancel')}
        />
      )
    case 'pick':
      return (
        <NativeSinglePicker
          visible={pickerOpen}
          title={request.title}
          sections={groupPickerSections(request.options)}
          selected={request.selected}
          searchable={request.searchable}
          onSelect={(value) => {
            picked.current = value
          }}
          onClose={() => setPickerOpen(false)}
          // Answer once the sheet has gone: the page's next dialog can only present after it.
          onAfterClose={() => {
            const value = picked.current
            queue.answer(token, value === null ? 'dismiss' : 'confirm', value ?? undefined)
          }}
        />
      )
  }
}
