import { describe, expect, it } from 'vitest'
import {
  BUNDLED_AGENT_STATE_RULE_FILES,
  parseAgentStateRuleFiles,
  RAW_BUNDLED_AGENT_STATE_RULE_FILES
} from './agent-state-rules-catalog'

describe('bundled agent state rule files', () => {
  it('are used as bundled, without parsing, so parsing must not change them', () => {
    expect(BUNDLED_AGENT_STATE_RULE_FILES).toBe(RAW_BUNDLED_AGENT_STATE_RULE_FILES)
    expect(parseAgentStateRuleFiles(RAW_BUNDLED_AGENT_STATE_RULE_FILES)).toStrictEqual(
      RAW_BUNDLED_AGENT_STATE_RULE_FILES
    )
  })
})
