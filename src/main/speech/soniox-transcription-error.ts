import { sanitizeSonioxError } from './soniox-error-sanitization'
import type { SonioxResponse } from './soniox-transcription-response'

const ERROR_MESSAGE_BY_TYPE: Record<string, string> = {
  unauthenticated: 'Soniox authentication failed. Check the configured API key.',
  invalid_request: 'Soniox rejected the transcription request.',
  model_not_available: 'The selected Soniox transcription model is unavailable.',
  organization_balance_exhausted: 'The Soniox account balance is exhausted.',
  organization_monthly_budget_exhausted: 'The Soniox organization budget is exhausted.',
  project_monthly_budget_exhausted: 'The Soniox project budget is exhausted.',
  temp_api_key_session_expired: 'The Soniox temporary API key expired.',
  max_duration_reached: 'The Soniox transcription session reached its maximum duration.',
  limit_exceeded: 'The Soniox transcription rate limit was reached.',
  request_timeout: 'Soniox transcription timed out.',
  internal_error: 'Soniox transcription is temporarily unavailable.',
  service_unavailable: 'Soniox transcription is temporarily unavailable.'
}

export function formatSonioxServerError(response: SonioxResponse, apiKey: string): string {
  const errorType = typeof response.error_type === 'string' ? response.error_type : 'unknown_error'
  const stableMessage = ERROR_MESSAGE_BY_TYPE[errorType] ?? 'Soniox transcription failed.'
  const requestId =
    typeof response.request_id === 'string' && response.request_id.trim()
      ? ` Request ID: ${sanitizeSonioxError(response.request_id, apiKey)}.`
      : ''
  return `${stableMessage}${requestId}`
}

export function sanitizeSonioxConnectionDiagnostic(error: Error, apiKey: string): string {
  return sanitizeSonioxError(error.message, apiKey)
}
