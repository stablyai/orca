import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type {
  AgentStatusIpcPayload,
  RefusedPaneResume
} from '../../../../shared/agent-status-types'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session-record-store'

export type ResumeSpawnArgs = {
  resume?: unknown
  startupAgent?: TuiAgent
  agentLaunch?: unknown
  connectionId?: string | null
  command?: string
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: unknown
  resumeProviderSession?: AgentProviderSessionMetadata
  /** `saved`: the resume was built from a pane's saved facts, not asked for by the user. */
  resumeOrigin?: unknown
  env?: Record<string, string>
}

export type AdmissionRuntime = {
  getAgentProviderSessionRows?(): AgentStatusIpcPayload[]
  readSavedResumeSource?(
    worktreeId: string,
    paneKey: string
  ): Promise<SleepingAgentSessionRecord | undefined>
  openAgentSessionRecordStore(): Promise<AgentSessionRecordStore>
}

/** `chat-home`: an automatic restore of a conversation an open chat continues; `chat-writing`:
 *  any start of one a chat may be writing; `unverifiable`: an automatic restore with no records. */
export type ResumeSpawnRefusal = {
  sourceRecord?: SleepingAgentSessionRecord
  verdict: 'chat-home' | 'chat-writing' | 'unverifiable'
  refused: RefusedPaneResume
}

export type ResumeSpawnAdmission =
  | { verdict: 'admitted'; refused: RefusedPaneResume; sourceRecord?: SleepingAgentSessionRecord }
  | ResumeSpawnRefusal
