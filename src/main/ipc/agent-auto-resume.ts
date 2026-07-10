import { ipcMain } from 'electron'
import type { AgentAutoResumeService } from '../agent-auto-resume-service'
import type { AgentAutoResumeSnapshot } from '../../shared/agent-auto-resume-types'

const EMPTY_SNAPSHOT: AgentAutoResumeSnapshot = { enabled: false, entries: [] }

// Why: the service only pushes snapshots on state changes, so a renderer that
// mounts after a stall was already detected would show stale UI until the next
// transition. This one-shot getter lets the renderer hydrate current state on
// startup, mirroring rateLimits.get().
export function registerAgentAutoResumeHandlers(service?: AgentAutoResumeService): void {
  ipcMain.removeHandler('agentAutoResume:get')
  ipcMain.handle(
    'agentAutoResume:get',
    (): AgentAutoResumeSnapshot => service?.getSnapshot() ?? EMPTY_SNAPSHOT
  )
}
