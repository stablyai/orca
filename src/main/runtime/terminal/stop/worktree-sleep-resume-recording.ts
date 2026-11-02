import { OrcaRuntimeWithStopTerminalsForWorktree } from './worktree-terminal-stop'
import {
  applyWorktreeSleepResumeRecords,
  captureWorktreeSleepResumeRecords,
  type WorktreeSleepResumeRecorder
} from './worktree-sleep-resume-records'

export abstract class OrcaRuntimeWithWorktreeSleepResumeRecording extends OrcaRuntimeWithStopTerminalsForWorktree {
  protected readonly sleepResumeRecords: WorktreeSleepResumeRecorder = {
    capture: (worktreeId, ptyIds) =>
      captureWorktreeSleepResumeRecords({
        worktreeId,
        paneKeysByPtyId: new Map(
          [...ptyIds].map((ptyId) => [ptyId, this.collectAgentStatusPaneKeysForPty(ptyId)])
        ),
        launchByPtyId: new Map(
          [...ptyIds].map((ptyId) => {
            const pty = this.ptysById.get(ptyId)
            return [ptyId, { agent: pty?.launchAgent ?? null, config: pty?.launchConfig ?? null }]
          })
        ),
        readRows: () => this.getAgentProviderSessionSnapshotFn?.() ?? [],
        checkAgentPresence: this.checkHookAgentPresenceFn,
        capturedAt: Date.now()
      }),
    persist: async (worktreeId, capture, stoppedPtyIds) => {
      try {
        await this.commitWorkspaceSessionEdit(
          this.getWorkspaceSessionHostIdForWorktree(worktreeId),
          (session) => applyWorktreeSleepResumeRecords(session, capture, stoppedPtyIds)
        )
      } catch (error) {
        // Why: the PTYs already stopped; a lost record costs the resume, not the sleep.
        console.error('[runtime] could not record slept agent sessions', { worktreeId, error })
      }
    }
  }
}
