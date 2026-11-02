import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session/agent-session-host-authority'
import type { CreateOrAttachOptions } from './terminal-host-create-contract'
import type {
  PreparedAgentLaunchIdentity,
  PreparedLaunchPublication
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
        action: 'wait'
        identity: PreparedAgentLaunchIdentity
        timeoutMs: number
        until?: 'setup' | 'launch'
      }
    | {
        /** Main's one explanation of a launch that never started, written as Setup's last line. */
        action: 'writeSetupOutcome'
        identity: PreparedAgentLaunchIdentity
        text: string
      }
    | { action: 'list'; after?: string; limit?: number }
}
