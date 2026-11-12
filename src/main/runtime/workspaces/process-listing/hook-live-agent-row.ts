import type { RuntimeAgentRowSnapshot } from './runtime-hook-agent-row-selection'

export type HookLiveAgentRow = Pick<
  RuntimeAgentRowSnapshot,
  | 'payload'
  | 'updatedAt'
  | 'evidenceObservedAt'
  | 'stateStartedAt'
  | 'turnEndedAt'
  | 'turnEndDisposition'
  | 'worktreeId'
  | 'programStatus'
  | 'paneSleep'
>
