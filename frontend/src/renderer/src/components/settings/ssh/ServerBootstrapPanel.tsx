// ServerBootstrapPanel — main bootstrap UI with step tracker and log viewer (CR-004, TASK-004-C)
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Terminal, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { SshTarget } from '../../../../../shared/ssh-types'
import { ServerBootstrapIdleScreen } from './ServerBootstrapIdleScreen'
import { BootstrapStepList } from './BootstrapStepList'
import { BootstrapLogViewer } from './BootstrapLogViewer'

export function ServerBootstrapPanel({ target }: { target: SshTarget }): React.JSX.Element {
  const bootstrapState = useAppStore((s) => s.bootstrapByServer[target.id])
  const [showLog, setShowLog] = useState(false)

  // Why: a page refresh mid-bootstrap has no bootstrapByServer entry yet
  // (that state only exists via live window.api.ssh.onBootstrapProgress
  // IPC events — see useIpcEvents.ts — nothing replays past events on
  // mount). Fall back to the coarse devServers[].healthStatus signal so the
  // panel shows "still bootstrapping"/"done" instead of the idle/start
  // screen — see resumeBootstrapProgressIfAny's own doc comment
  // (BACKLOG-007) for exactly what this can and can't tell the user.
  useEffect(() => {
    useAppStore.getState().resumeBootstrapProgressIfAny(target.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id])

  const handleStartBootstrap = async (): Promise<void> => {
    try {
      await window.api.ssh.bootstrapServer?.({
        serverId: target.id,
        options: { installNode: true, installGit: true, cloneRepos: true }
      })
    } catch {
      toast.error(translate('fleet.bootstrap.startError', 'Failed to start bootstrap'))
    }
  }

  const handleRetry = (): void => {
    useAppStore.getState().clearBootstrap(target.id)
    void handleStartBootstrap()
  }

  // Idle or no state → show idle/start screen
  if (!bootstrapState || bootstrapState.phase === 'idle') {
    return <ServerBootstrapIdleScreen target={target} onStart={() => void handleStartBootstrap()} />
  }

  return (
    <div className="space-y-4">
      {/* ── Steps tracker ── */}
      <BootstrapStepList steps={bootstrapState.steps} />

      {/* ── Phase indicator ── */}
      {bootstrapState.phase === 'running' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-block size-2 animate-pulse rounded-full bg-blue-500" />
          {translate('fleet.bootstrap.running', 'Bootstrap in progress...')}
        </div>
      )}

      {bootstrapState.phase === 'done' && (
        <div className="flex items-center gap-2 text-sm text-green-600">
          <span>✅</span>
          {translate('fleet.bootstrap.complete', 'Bootstrap complete! Server is ready.')}
        </div>
      )}

      {bootstrapState.phase === 'error' && (
        <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">
            {translate('fleet.bootstrap.failed', 'Bootstrap failed. Check log below.')}
          </p>
          <Button variant="outline" size="sm" onClick={handleRetry}>
            {translate('fleet.bootstrap.retry', 'Retry Bootstrap')}
          </Button>
        </div>
      )}

      {/* ── Log toggle (collapsed by default) ── */}
      <Collapsible open={showLog} onOpenChange={setShowLog}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
            <Terminal className="size-4" />
            {translate('fleet.bootstrap.showLog', 'Bootstrap log')}
            <ChevronDown
              className={cn('size-4 transition-transform duration-150', showLog && 'rotate-180')}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <BootstrapLogViewer lines={bootstrapState.logLines} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
