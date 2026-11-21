import type { AcpDialect } from './acp-dialect'

// Devin's `_cognition.ai/*` notifications carry nothing Orca shows; the translator drops what it
// does not map. The mode commands switch the session's mode behind the chat's permission picker.
export const DEVIN_ACP_DIALECT: AcpDialect = {
  withheldCommands: ['ask', 'plan', 'code', 'smart', 'bypass']
}
