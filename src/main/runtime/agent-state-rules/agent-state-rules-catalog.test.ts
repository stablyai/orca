import { describe, expect, it } from 'vitest'
import {
  parseAgentStateRuleFiles,
  RAW_BUNDLED_AGENT_STATE_RULE_FILES
} from './agent-state-rules-catalog'

describe('the bundled agent state rules', () => {
  // Why: the bundle loads them unchecked, but a live update of the same files is parsed and refused whole.
  it('parse as a live update would', () => {
    expect(() => parseAgentStateRuleFiles(RAW_BUNDLED_AGENT_STATE_RULE_FILES)).not.toThrow()
  })
})
