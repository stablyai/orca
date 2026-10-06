import { describe, expect, it } from 'vitest'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import {
  CLAUDE_STRUCTURED_HANDLE_NAMESPACE,
  CODEX_STRUCTURED_HANDLE_NAMESPACE
} from '../../shared/agent-session-provider-handle-encoding'

describe('what the shipped definitions let a record store', () => {
  it('pins what every older build wrote', () => {
    expect(CLAUDE_STRUCTURED_AGENT).toMatchObject({
      handleTransport: CLAUDE_STRUCTURED_HANDLE_NAMESPACE.transport,
      accountHomeVariable: 'CLAUDE_CONFIG_DIR'
    })
    expect(CODEX_STRUCTURED_AGENT).toMatchObject({
      handleTransport: CODEX_STRUCTURED_HANDLE_NAMESPACE.transport,
      accountHomeVariable: 'CODEX_HOME'
    })
  })
})
