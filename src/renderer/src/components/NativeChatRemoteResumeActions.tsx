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
        {translate(
          startedHere.length === 1
            ? 'auto.components.NativeChatResumeOnRestartModal.serverResumeHereOne'
            : 'auto.components.NativeChatResumeOnRestartModal.serverResumeHere',
          startedHere.length === 1
            ? 'Resume 1 chat started here'
            : 'Resume {{count}} chats started here',
          { count: startedHere.length }
        )}
      </Button>
    </>
  )
}
