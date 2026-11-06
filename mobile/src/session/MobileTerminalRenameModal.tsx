import { useState } from 'react'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { TextInputSheetContent } from '../components/TextInputModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { Terminal } from './mobile-session-route-types'
import type { MobileSessionController } from './use-mobile-session-controller'

// error null means the rename is still in flight.
type RenameAttempt = { error: string | null }

export function MobileTerminalRenameModal({
  controller
}: {
  controller: Pick<
    MobileSessionController,
    'renameTarget' | 'setRenameTarget' | 'handleRenameTerminal'
  >
}) {
  const t = useMobileTranslation()
  const { renameTarget, setRenameTarget, handleRenameTerminal } = controller
  const [shownTarget, setShownTarget] = useState<Terminal | null>(renameTarget)
  const [value, setValue] = useState(renameTarget?.title ?? '')
  const [attempt, setAttempt] = useState<RenameAttempt | null>(null)

  // Each opening starts from the terminal's title; closing keeps the text for the exit animation.
  if (renameTarget !== shownTarget) {
    setShownTarget(renameTarget)
    if (renameTarget) {
      setValue(renameTarget.title)
      setAttempt(null)
    }
  }

  async function submit(title: string) {
    const mine: RenameAttempt = { error: null }
    setAttempt(mine)
    try {
      await handleRenameTerminal(title)
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : ''
      const error = t(
        'session.sheets.renameTerminalFailed',
        "Couldn't rename the terminal. {{reason}}",
        { reason }
      ).trim()
      // A late reply must not mark a newer attempt or opening as failed.
      setAttempt((latest) => (latest === mine ? { error } : latest))
    }
  }

  return (
    <BottomDrawer visible={renameTarget != null} onClose={() => setRenameTarget(null)}>
      <TextInputSheetContent
        title={t('session.sheets.renameTerminal', 'Rename Terminal')}
        value={value}
        onChangeText={setValue}
        placeholder={t('session.sheets.terminalName', 'Terminal name')}
        submitLabel={attempt?.error ? t('common.retry', 'Retry') : undefined}
        error={attempt?.error}
        busy={attempt != null && attempt.error === null}
        onSubmit={(title) => void submit(title)}
        onCancel={() => setRenameTarget(null)}
      />
    </BottomDrawer>
  )
}
