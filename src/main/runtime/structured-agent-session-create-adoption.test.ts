import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { structuredAdoptionAccountHomeCandidates } from './structured-agent-session-create-adoption'

const SHARED_CLAUDE_HOME = join(homedir(), '.claude')

describe('structured adoption account-home candidates', () => {
  it('offers the shared Claude home after an unbound selection', () => {
    expect(
      structuredAdoptionAccountHomeCandidates({
        settings: {},
        agent: 'claude',
        selectedAccountHomePath: '/accounts/selected',
        selectedAccountHomeBound: false
      })
    ).toEqual(['/accounts/selected', SHARED_CLAUDE_HOME])
  })

  // The shared home is another organisation's account. Resuming a conversation that lives there
  // under a bound group must refuse, never quietly commit the session to `~/.claude`.
  it('offers the bound home alone when a project-group binding chose it', () => {
    expect(
      structuredAdoptionAccountHomeCandidates({
        settings: {},
        agent: 'claude',
        selectedAccountHomePath: '/bound/claude-home',
        selectedAccountHomeBound: true
      })
    ).toEqual(['/bound/claude-home'])
  })

  it('leaves the Codex candidate list alone', () => {
    expect(
      structuredAdoptionAccountHomeCandidates({
        settings: { codexManagedAccounts: [{ managedHomePath: '/managed/codex' }] },
        agent: 'codex',
        selectedAccountHomePath: '/accounts/selected',
        selectedAccountHomeBound: false
      })
    ).toContain('/managed/codex')
  })
})
