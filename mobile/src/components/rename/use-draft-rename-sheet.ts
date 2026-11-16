import { useEffect, useRef, useState } from 'react'
import { ClockFading, CloudOff } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { isHostRouteUnreachableError, type HostMutationPhase } from '../../query/host-mutation'
import { readHostMutationDraft, setHostMutationDraft } from '../../query/host-mutation-drafts'
import { isHostNotConnectedError } from '../../query/host-query-errors'

// error null means the rename is still in flight; token tells this attempt from a later one.
type RenameAttempt = { token: object; error: string | null; phase: HostMutationPhase }

/**
 * One rename sheet over a draft-mode write: it never claims a name the desktop hasn't taken.
 * Offline, Save is off and the text is kept; a lost reply waits as "Not confirmed"; a refusal offers Retry.
 * Text the desktop couldn't take outlives the sheet in its draft slot; a plain Cancel drops it.
 */
export function useDraftRenameSheet({
  draftKey,
  currentName,
  blockedOffline,
  hostName,
  failureMessage,
  rename,
  onRenamed
}: {
  /** The open target's draft slot, or null while the sheet is closed. */
  draftKey: string | null
  currentName: string
  blockedOffline: boolean
  hostName: string
  failureMessage: (reason: string) => string
  rename: (name: string, onPhase: (phase: HostMutationPhase) => void) => Promise<void>
  /** Called after an accepted rename while this sheet is still mounted. */
  onRenamed?: () => void
}) {
  const t = useMobileTranslation()
  const [shownKey, setShownKey] = useState(draftKey)
  const [value, setValue] = useState(
    () => (draftKey ? readHostMutationDraft(draftKey) : undefined) ?? currentName
  )
  const [attempt, setAttempt] = useState<RenameAttempt | null>(null)
  // Each opening starts from the current name, or the text the desktop never took; closing keeps the text for the exit animation.
  if (draftKey !== shownKey) {
    setShownKey(draftKey)
    if (draftKey) {
      setValue(readHostMutationDraft(draftKey) ?? currentName)
      setAttempt(null)
    }
  }

  // Offline wins over an older refusal: Save is off, and the notice says why.
  const error = blockedOffline ? null : (attempt?.error ?? null)
  const busy = attempt !== null && attempt.error === null
  const unconfirmed = attempt?.phase === 'unconfirmed'
  const notice = unconfirmed
    ? {
        icon: ClockFading,
        text: t(
          'hostMutation.renameUnconfirmed',
          'Not confirmed yet. Orca checks the name when {{host}} is back.',
          { host: hostName }
        )
      }
    : blockedOffline
      ? {
          icon: CloudOff,
          text: t(
            'hostMutation.renameOffline',
            '{{host}} is offline. Your text stays here until you can save.',
            { host: hostName }
          )
        }
      : null

  // The slot is written when the target closes or the sheet unmounts, however the drawer was dismissed.
  const unsaved = notice !== null && value.trim() !== currentName ? value : null
  // Keyed, so a late success for one target never clears another target's text.
  const unsavedRef = useRef({ key: shownKey, text: unsaved })
  useEffect(() => {
    unsavedRef.current = { key: shownKey, text: unsaved }
  })
  useEffect(
    () => () => {
      if (shownKey && unsavedRef.current.key === shownKey) {
        setHostMutationDraft(shownKey, unsavedRef.current.text)
      }
    },
    [shownKey]
  )
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function submit(name: string) {
    if (!draftKey) {
      return
    }
    const key = draftKey
    const token = {}
    setAttempt({ token, error: null, phase: 'pending' })
    try {
      await rename(name, (phase) =>
        setAttempt((latest) =>
          latest?.token === token && phase !== 'idle' ? { ...latest, phase } : latest
        )
      )
      // Only the text this save sent is done; anything typed since (an older save landing late) stays.
      const sent = (text: string | null | undefined) => text?.trim() === name
      if (unsavedRef.current.key === key && sent(unsavedRef.current.text)) {
        unsavedRef.current = { key, text: null }
      }
      if (sent(readHostMutationDraft(key))) {
        setHostMutationDraft(key, null)
      }
      setAttempt((latest) => (latest?.token === token ? null : latest))
      if (mountedRef.current) {
        onRenamed?.()
      }
    } catch (failure) {
      // Offline before it was sent: the offline notice says why, and the text waits.
      const failed = isHostNotConnectedError(failure)
        ? null
        : failureMessage(
            isHostRouteUnreachableError(failure)
              ? t('hostMutation.serverUnreachable', "Its server can't be reached.")
              : failure instanceof Error
                ? failure.message
                : ''
          ).trim()
      // A late reply must not mark a newer attempt or opening as failed.
      setAttempt((latest) =>
        latest?.token === token ? (failed ? { token, error: failed, phase: 'idle' } : null) : latest
      )
    }
  }

  return {
    value,
    submit,
    sheetProps: {
      value,
      onChangeText: setValue,
      error,
      busy,
      notice,
      submitBlocked: blockedOffline,
      submitLabel: error
        ? t('common.retry', 'Retry')
        : unconfirmed
          ? t('hostMutation.saving', 'Saving')
          : undefined
    }
  }
}
