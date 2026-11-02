import { describe, expect, it } from 'vitest'
import { ownership, withoutOwnedBinding } from './agent-view-binding-plan'
import {
  parseClaudeAgentViewBindings,
  serializeClaudeAgentViewBindings
} from './agent-view-keybindings'

const marker = { ...ownership, binding: { context: 'Chat', chord: 'ctrl+shift+a' } }

const cases = [
  {
    name: 'the last block in a compact file',
    original:
      '{"bindings":[{"context":"Chat","bindings":{"ctrl+k":"chat:clear"}},{"context":"Chat","bindings":{"ctrl+shift+a":"command:orca-agent-view"}}]}',
    expected: { bindings: [{ context: 'Chat', bindings: { 'ctrl+k': 'chat:clear' } }] }
  },
  {
    name: 'the only property with a trailing comma in a block with user metadata',
    original:
      '{"bindings":[{"context":"Chat","note":"mine","bindings":{"ctrl+shift+a":"command:orca-agent-view",}}]}',
    expected: { bindings: [{ context: 'Chat', note: 'mine', bindings: {} }] }
  }
]

describe('retiring the owned agent-view keybinding', () => {
  it.each(cases)('preserves user data when removing $name', ({ original, expected }) => {
    const config = parseClaudeAgentViewBindings(original)!
    const output = serializeClaudeAgentViewBindings(original, withoutOwnedBinding(config, marker))
    expect(parseClaudeAgentViewBindings(output)).toEqual(expected)
  })
})
