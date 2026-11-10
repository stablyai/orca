import type { OwnedPaneAgentRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import {
  applyWorktreeSleepResumeRecords,
  type WorktreeSleepRecordTransaction,
  type WorktreeSleepResumeCapture
} from './worktree-sleep-resume-records'

type SleepRecordTransactionHost = {
  edit: (change: (session: WorkspaceSessionState) => WorkspaceSessionState | null) => Promise<void>
  ptyById: (ptyId: string) => RuntimePtyWorktreeRecord | undefined
  ptyForPane: (paneKey: string) => RuntimePtyWorktreeRecord | null
  publish: () => void
}

/** Stage the exact targets before stop; uncertainty keeps their capture, verified liveness rolls it back. */
export async function prepareWorktreeSleepRecords(
  worktreeId: string,
  capture: WorktreeSleepResumeCapture,
  isCurrent: () => boolean,
  host: SleepRecordTransactionHost
): Promise<WorktreeSleepRecordTransaction> {
  const previous = new Map<string, OwnedPaneAgentRecord | undefined>()
  const staged = new Map<string, string>()
  const targets = new Map([...capture.keys()].map((ptyId) => [ptyId, host.ptyById(ptyId)]))
  let stagedSuccessfully = false
  try {
    await host.edit((session) => {
      const next = applyWorktreeSleepResumeRecords(session, capture, [...capture.keys()])
      if (!next) {
        return null
      }
      for (const entry of capture.values()) {
        for (const record of entry.records) {
          const value = next.sleepingAgentSessionsByPaneKey?.[record.paneKey]
          if (value?.capturedAt !== record.capturedAt) {
            continue
          }
          previous.set(record.paneKey, session.sleepingAgentSessionsByPaneKey?.[record.paneKey])
          staged.set(record.paneKey, JSON.stringify(value))
        }
      }
      return next
    })
    stagedSuccessfully = true
    host.publish()
  } catch (error) {
    console.error('[runtime] could not stage slept agent sessions', { worktreeId, error })
  }
  const settle: WorktreeSleepRecordTransaction['settle'] = async (runningPtyIds) => {
    if (runningPtyIds.length === 0 || !isCurrent()) {
      return
    }
    const running = new Set(runningPtyIds)
    await host
      .edit((session) => {
        if (!isCurrent()) {
          return null
        }
        let next = session.sleepingAgentSessionsByPaneKey
        for (const [ptyId, entry] of capture) {
          if (!running.has(ptyId)) {
            continue
          }
          for (const record of entry.records) {
            const key = record.paneKey
            const currentPty = host.ptyForPane(key)
            if (
              !currentPty ||
              currentPty.ptyId !== ptyId ||
              currentPty.incarnationId !== targets.get(ptyId)?.incarnationId
            ) {
              continue
            }
            if (!staged.has(key) || JSON.stringify(next?.[key]) !== staged.get(key)) {
              continue
            }
            if (next === session.sleepingAgentSessionsByPaneKey) {
              next = { ...next }
            }
            const prior = previous.get(key)
            if (prior) {
              next![key] = prior
            } else {
              delete next![key]
            }
          }
        }
        return next === session.sleepingAgentSessionsByPaneKey
          ? null
          : { ...session, sleepingAgentSessionsByPaneKey: next }
      })
      .catch((error) =>
        console.error('[runtime] could not settle slept agent sessions', { worktreeId, error })
      )
    host.publish()
  }
  return { staged: stagedSuccessfully, settle }
}
