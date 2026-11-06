import type { AgentLaunchParams } from '../../shared/rpc-contract/agent-launch-params'
import type {
  FollowUpAction,
  FollowUpObservation,
  FollowUpObservationSource,
  FollowUpTarget
} from '../../shared/pr-follow-ups/contracts'
import type { PrFollowUpsSettings } from '../../shared/pr-follow-ups/settings'
import type { FollowUpStore } from './store'

export type FollowUpReceipt =
  | {
      status: 'accepted'
      identity: Partial<
        Pick<
          FollowUpAction,
          | 'surface'
          | 'sessionId'
          | 'terminalHandle'
          | 'paneKey'
          | 'terminalPtyId'
          | 'transcriptChatId'
          | 'promptUnconfirmed'
        >
      >
    }
  | { status: 'absent' | 'unconfirmed' | 'declined' }

export type FollowUpEngineDependencies = {
  source: FollowUpObservationSource
  store: FollowUpStore
  globalSettings(): PrFollowUpsSettings | undefined
  targets(): readonly FollowUpTarget[]
  liveInstanceIds(): ReadonlySet<string>
  prepare(
    observation: FollowUpObservation,
    names: string[],
    target: FollowUpTarget
  ): Promise<AgentLaunchParams>
  recipe(target: FollowUpTarget): { agent: string; surface: 'terminal' | 'chat' }
  working(action: FollowUpAction): boolean
  canPublishAgentLaunchTab(): boolean
  launch(params: AgentLaunchParams): Promise<FollowUpReceipt>
  recover(action: FollowUpAction): Promise<FollowUpReceipt>
  live(action: FollowUpAction): Promise<boolean | 'unknown'>
  started?(action: FollowUpAction): void
  changed?(): void
  now?(): number
}
