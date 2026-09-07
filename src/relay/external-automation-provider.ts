export type ExternalAutomationProvider = 'hermes' | 'openclaw'

export type ExternalAutomationAction = 'pause' | 'resume' | 'run' | 'delete'

export const EXTERNAL_AUTOMATION_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

export function externalAutomationProvider(value: unknown): ExternalAutomationProvider {
  return value === 'openclaw' ? 'openclaw' : 'hermes'
}

export function isExternalAutomationAction(value: unknown): value is ExternalAutomationAction {
  return value === 'pause' || value === 'resume' || value === 'run' || value === 'delete'
}
