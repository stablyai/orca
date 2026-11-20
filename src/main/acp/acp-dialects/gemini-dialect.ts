import type { AcpDialect } from './acp-dialect'

// Failed prompts carry the model API's HTTP status as their error code.
export const GEMINI_ACP_DIALECT: AcpDialect = {
  authenticationRequired: (error) => error.code === 401,
  promptFailure: (error) => (error.code === 429 ? { stopReason: 'rate_limit' } : undefined)
}
