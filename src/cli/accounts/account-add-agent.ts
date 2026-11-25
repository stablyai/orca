import { RuntimeClientError } from '../runtime/connection/types'

const ADD_ACCOUNT_AGENTS: readonly string[] = [
  'claude',
  'codex',
  'opencode',
  'devin',
  'commandcode'
]

export type AddAccountAgent = 'claude' | 'codex' | 'opencode' | 'devin' | 'commandcode'

export function assertAddAccountAgent(agent: string): asserts agent is AddAccountAgent {
  if (!ADD_ACCOUNT_AGENTS.includes(agent)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --agent "${agent}". Use "claude", "codex", "opencode", "devin", or "commandcode".`
    )
  }
}
