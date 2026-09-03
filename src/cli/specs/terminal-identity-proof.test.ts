import { describe, expect, it } from 'vitest'
import { formatCommandHelp } from '../help'
import { TERMINAL_IDENTITY_PROOF_COMMAND_SPECS } from './terminal-identity-proof'

describe('terminal identity proof command specs', () => {
  it('scopes conflict-free title assignment without promising global uniqueness or send fencing', () => {
    const complete = TERMINAL_IDENTITY_PROOF_COMMAND_SPECS.find(
      (entry) => entry.path.join(' ') === 'terminal identity-proof complete'
    )
    expect(complete).toBeDefined()
    const help = formatCommandHelp(complete!)
    expect(help).toContain('conflict-free title within authoritative worktree scope')
    expect(help).not.toMatch(/atomically|unique name/i)
  })
})
