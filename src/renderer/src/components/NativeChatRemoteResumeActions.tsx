import { Button } from './ui/button'
import { translate } from '@/i18n/i18n'
import type { NativeChatRestartStore } from './native-chat-resume-on-restart-store'

export function NativeChatRemoteResumeActions({
  store,
  machineName,
  chosen,
  busy,
  resume,
  dismiss,
  resumeButtonRef
}: {
  store: NativeChatRestartStore
  machineName: string
  chosen: readonly string[]
  busy: boolean
  resume: (ids: string[]) => void
  dismiss: () => void
  resumeButtonRef: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  const all = [...chosen]
  const startedHere = all.filter(store.startedHere)
  return (
    <>
      <Button variant="ghost" size="sm" disabled={busy} onClick={dismiss}>
        {translate('auto.components.NativeChatResumeOnRestartModal.serverDismiss', 'Dismiss')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || all.length === 0}
        onClick={() => resume(all)}
      >
        {translate(
          'auto.components.NativeChatResumeOnRestartModal.serverResumeAll',
          'Resume all {{count}} on {{machine}}',
          { count: all.length, machine: machineName }
        )}
      </Button>
      <Button
        ref={resumeButtonRef}
        variant="default"
        size="sm"
        disabled={busy || startedHere.length === 0}
        onClick={() => resume(startedHere)}
      >
        {startedHere.length === 1
          ? translate(
              'auto.components.NativeChatResumeOnRestartModal.serverResumeHereCount_one',
              'Resume {{count}} chat started here',
              { count: startedHere.length }
            )
          : translate(
              'auto.components.NativeChatResumeOnRestartModal.serverResumeHereCount_other',
              'Resume {{count}} chats started here',
              { count: startedHere.length }
            )}
      </Button>
    </>
  )
}
