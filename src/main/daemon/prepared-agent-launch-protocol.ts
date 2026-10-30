import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type { CreateOrAttachOptions } from './terminal-host-create-contract'
import type { PreparedAgentLaunchIdentity } from '../../shared/prepared-agent-launch'
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
        setup?: { spawn: PreparedAgentSpawn; attemptId: string; deadline: number }
      }
    | {
        action: 'status' | 'cancel' | 'ackPublication' | 'retireInput'
        identity: PreparedAgentLaunchIdentity
      }
    | { action: 'claimPrompt' | 'settlePrompt'; identity: PreparedAgentLaunchIdentity }
    | {
        action: 'wait'
        identity: PreparedAgentLaunchIdentity
        timeoutMs: number
        until?: 'setup' | 'launch'
      }
    | { action: 'list'; after?: string; limit?: number }
}
