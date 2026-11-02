import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type { CreateOrAttachOptions } from './terminal-host-create-contract'
import type {
  PreparedAgentLaunchIdentity,
  PreparedLaunchInputOutcome,
  PreparedLaunchPublication,
  PreparedPromptConsumer
} from '../../shared/prepared-agent-launch'
export { isPreparedAgentLaunchStatus } from '../../shared/prepared-agent-launch'
export type {
  PreparedAgentLaunchIdentity,
  PreparedAgentLaunchDescriptor,
  PreparedAgentLaunchStatus
} from '../../shared/prepared-agent-launch'

export type PreparedAgentSpawn = Omit<
  CreateOrAttachOptions,
  'streamClient' | 'onSessionResolved' | 'agentSessionEnsure' | 'attachOnly' | 'historySeedChunks'
> &
  Pick<PtySpawnOptions, 'spawnIntent'>

export type PreparedTerminalPrompts = {
  draft?: { agent: TuiAgent; content: string }
  followup?: { agent: TuiAgent; prompt: string }
}

export type PreparedAgentLaunchRequest = {
  id: string
  type: 'preparedAgentLaunch'
  payload:
    | {
        action: 'prepare'
        operationId: string
        fingerprint: string
        claim: AgentSessionExecutionClaim
        surface: AgentSessionSurfaceBinding
      }
    | {
        action: 'accept'
        identity: PreparedAgentLaunchIdentity
        launch: PreparedAgentSpawn
        prompts?: PreparedTerminalPrompts
        publication?: Omit<PreparedLaunchPublication, 'launchToken'>
        setup?: { spawn: PreparedAgentSpawn; attemptId: string; deadline: number }
      }
    | {
        action: 'status'
        identity: PreparedAgentLaunchIdentity
        /** Only the exact publication observer asks; routing probes and lists never carry it. */
        publication?: true
      }
    | {
        action: 'cancel' | 'ackPublication' | 'retireInput'
        identity: PreparedAgentLaunchIdentity
      }
    | {
        action: 'claimPrompt'
        identity: PreparedAgentLaunchIdentity
        consumer: PreparedPromptConsumer
        /** Acquisition grants nothing; an attempt is the exclusive right to begin writing. */
        attempt?: true
      }
    | {
        action: 'settlePrompt'
        identity: PreparedAgentLaunchIdentity
        consumer: PreparedPromptConsumer
        outcome: PreparedLaunchInputOutcome
      }
    | {
        action: 'wait'
        identity: PreparedAgentLaunchIdentity
        timeoutMs: number
        until?: 'setup' | 'launch'
      }
    | { action: 'list'; after?: string; limit?: number }
}
