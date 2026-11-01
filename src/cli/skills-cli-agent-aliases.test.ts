import { describe, expect, it } from 'vitest'
import { SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT } from '../shared/skills-cli-agent-keys'
import { skillsCliAgentAliases } from './skills-cli-agent-aliases'

describe('skills CLI agent aliases', () => {
  it('resolves shipped collisions canonically regardless of table order', () => {
    for (const entries of [
      Object.entries(SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT),
      Object.entries(SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT).toReversed()
    ]) {
      const aliases = skillsCliAgentAliases(Object.fromEntries(entries))

      expect(aliases.get('claude-code')).toBe('claude')
      expect(aliases.get('opencode')).toBe('opencode')
      expect(aliases.get('gemini-cli')).toBe('gemini')
    }
  })

  it.each(['new-key', 'codex'])(
    'rejects a new collision for %s without a canonical choice',
    (key) => {
      expect(() => skillsCliAgentAliases({ claude: key, codex: key })).toThrow(
        `Skills CLI agent key "${key}" needs an explicit canonical provider.`
      )
    }
  )
})
