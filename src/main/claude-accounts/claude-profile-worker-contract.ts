import type {
  provisionClaudeAccountProfile,
  ClaudeProfileSetupReport
} from './claude-profile-setup'
export type ClaudeProfileSetupJob = Omit<
  Parameters<typeof provisionClaudeAccountProfile>[0],
  'installHooks'
> & {
  hooksEnabled: boolean
  claudeVersion: string | undefined
}
export type ClaudeProfileWorkerRequest = { id: number; job: ClaudeProfileSetupJob }
export type ClaudeProfileWorkerResponse = { id: number } & (
  | { ok: true; report: ClaudeProfileSetupReport }
  | { ok: false; message: string }
)
