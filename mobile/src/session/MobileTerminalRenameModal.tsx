import { useState } from 'react'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { draftRenameSheetState } from '../components/draft-rename-sheet-state'
import { TextInputSheetContent } from '../components/TextInputModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { HostMutationPhase } from '../query/host-mutation'
import { readHostMutationDraft, setHostMutationDraft } from '../query/host-mutation-drafts'
import { isHostNotConnectedError } from '../query/host-query-errors'
import { useHostDisplay } from '../transport/use-host-display'
import { useHostProfile } from '../transport/use-host-profile'
import type { Terminal } from './mobile-session-route-types'
import type { MobileSessionController } from './use-mobile-session-controller'

// error null means the rename is still in flight; token tells this attempt from a later one.
type RenameAttempt = { token: object; error: string | null; phase: HostMutationPhase }

function renameDraftKey(hostId: string, terminal: Terminal): string {
  return `terminal-rename:${hostId}:${terminal.handle}`
}

export function MobileTerminalRenameModal({
  controller
}: {
  controller: Pick<
    MobileSessionController,
    'hostId' | 'renameTarget' | 'setRenameTarget' | 'handleRenameTerminal' | 'terminalRenameWrite'
  >
}) {
  const t = useMobileTranslation()
  const { hostId, renameTarget, setRenameTarget, handleRenameTerminal, terminalRenameWrite } =
    controller
  const hostName = useHostDisplay(useHostProfile(hostId)).title
  const [shownTarget, setShownTarget] = useState<Terminal | null>(renameTarget)
  const [value, setValue] = useState(renameTarget?.title ?? '')
  const [attempt, setAttempt] = useState<RenameAttempt | null>(null)

  // Each opening starts from the terminal's title, or the text the desktop never took; closing keeps the text for the exit animation.
  if (renameTarget !== shownTarget) {
    setShownTarget(renameTarget)
    if (renameTarget) {
      setValue(readHostMutationDraft(renameDraftKey(hostId, renameTarget)) ?? renameTarget.title)
      setAttempt(null)
    }
  }

  async function submit(title: string) {
    if (!renameTarget) {
      return
    }
    const draftKey = renameDraftKey(hostId, renameTarget)
    const token = {}
    setAttempt({ token, error: null, phase: 'pending' })
    const onPhase = (phase: HostMutationPhase) =>
      setAttempt((latest) =>
        latest?.token === token && phase !== 'idle' ? { ...latest, phase } : latest
      )
    try {
      await handleRenameTerminal(title, onPhase)
      setHostMutationDraft(draftKey, null)
    } catch (failure) {
      // Offline before it was sent: the sheet's offline notice says why, and the text waits.
      const error = isHostNotConnectedError(failure)
        ? null
        : t('session.sheets.renameTerminalFailed', "Couldn't rename the terminal. {{reason}}", {
            reason: failure instanceof Error ? failure.message : ''
          }).trim()
      // A late reply must not mark a newer attempt or opening as failed.
      setAttempt((latest) =>
        latest?.token === token ? (error ? { token, error, phase: 'idle' } : null) : latest
      )
    }
  }

  const busy = attempt != null && attempt.error === null
  const sheet = draftRenameSheetState({
    blockedOffline: terminalRenameWrite.blockedOffline,
    phase: attempt?.phase ?? 'idle',
    error: attempt?.error ?? null,
    hostName,
    t
  })

  function close() {
    if (shownTarget) {
      // Text the desktop couldn't take yet comes back next time; a plain Cancel drops it.
      const waiting = sheet.submitBlocked || sheet.notice !== null
      const unsaved = waiting && value.trim() !== shownTarget.title
      setHostMutationDraft(renameDraftKey(hostId, shownTarget), unsaved ? value : null)
    }
    setRenameTarget(null)
  }

  return (
    <BottomDrawer visible={renameTarget != null} onClose={close}>
      <TextInputSheetContent
        title={t('session.sheets.renameTerminal', 'Rename Terminal')}
        value={value}
        onChangeText={setValue}
        placeholder={t('session.sheets.terminalName', 'Terminal name')}
        error={attempt?.error}
        busy={busy}
        {...sheet}
        onSubmit={(title) => void submit(title)}
        onCancel={close}
      />
    </BottomDrawer>
  )
}
