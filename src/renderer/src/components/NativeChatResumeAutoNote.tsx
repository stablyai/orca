import { translate } from '@/i18n/i18n'
import { useAppStore } from '../store'
import { Button } from './ui/button'
import { NATIVE_CHAT_RESUME_SETTING_SECTION_ID } from './settings/native-chat-resume-setting-target'

/** Explain automatic resume only for runs started by this launch’s saved preference, with its settings link. */
export function NativeChatResumeAutoNote({
  inFlight,
  onOpenSettings
}: {
  inFlight: boolean
  /** Closes the dialog so the settings page is not left under it. */
  onOpenSettings: () => void
}): React.JSX.Element {
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  return (
    <div className="order-last flex min-w-0 flex-wrap items-center text-xs text-muted-foreground sm:order-none sm:mr-auto">
      <span>
        {inFlight
          ? translate(
              'auto.components.NativeChatResumeAutoNote.resuming',
              'Resuming automatically after the restart.'
            )
          : translate(
              'auto.components.NativeChatResumeAutoNote.resumed',
              'Resumed automatically after the restart.'
            )}
      </span>
      <Button
        variant="link"
        size="xs"
        onClick={() => {
          onOpenSettings()
          openSettingsPage()
          openSettingsTarget({
            pane: 'chat',
            repoId: null,
            sectionId: NATIVE_CHAT_RESUME_SETTING_SECTION_ID
          })
        }}
      >
        {translate(
          'auto.components.NativeChatResumeAutoNote.changeInSettings',
          'Change in Settings'
        )}
      </Button>
    </div>
  )
}
