export const PROFILE_STATE_AUTOMATION_RUNS_TABLE = 'profile_state_automation_runs'
export const PROFILE_STATE_AUTOMATION_RUNS_META_TABLE = 'profile_state_automation_runs_meta'

export const AUTOMATION_RUNS_DOMAIN = 'automationRuns'
export const AUTOMATION_RUNS_ABSENT = 'absent'
export const AUTOMATION_RUNS_NULL = 'null'
export const AUTOMATION_RUNS_ARRAY = 'array'
export const AUTOMATION_RUNS_DOCUMENT = 'document'

export type AutomationRunsPresence =
  | typeof AUTOMATION_RUNS_DOCUMENT
  | typeof AUTOMATION_RUNS_ABSENT
  | typeof AUTOMATION_RUNS_NULL
  | typeof AUTOMATION_RUNS_ARRAY

export type AutomationRunsMeta = {
  presence: AutomationRunsPresence
  domainVersion: number
  revision: number
  updatedAt: number
  contentHash: string
}

export type AutomationRunPayload = {
  id: string
  ordinal: number
  payload: string
  contentHash: string
}

export type NormalizedAutomationRunRow = AutomationRunPayload & {
  revision: number
  updatedAt: number
}

export type AutomationRunIdentity = {
  id: string
  ordinal: number
  contentHash: string
}

export type ParsedAutomationRunsReplacement =
  | { presence: typeof AUTOMATION_RUNS_ABSENT; contentHash: ''; runs?: undefined }
  | { presence: typeof AUTOMATION_RUNS_NULL; contentHash: string; runs?: undefined }
  | {
      presence: typeof AUTOMATION_RUNS_ARRAY
      contentHash: string
      runs: readonly AutomationRunPayload[]
    }
