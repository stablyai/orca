import type { AcpDialect } from './acp-dialect'

// Devin's `_cognition.ai/*` notifications carry nothing Orca shows, and the translator already drops
// what it does not map. `ask`, `plan`, `code`, `smart` and `bypass` switch the session's mode on its
// own, behind the chat's permission picker, so a slash command could desync it.
export const DEVIN_ACP_DIALECT: AcpDialect = {
  withheldCommands: ['ask', 'plan', 'code', 'smart', 'bypass']
}
