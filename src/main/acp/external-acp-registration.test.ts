import { describe, expect, it } from 'vitest'
import { parseExternalAcpRegistrations } from './external-acp-registration'

const entry = { agent: 'hermes', command: '/opt/agent/hermes-acp', args: [] }

describe('external ACP registration boundary', () => {
  it('accepts literal argv and arbitrary bounded agent IDs', () => {
    expect(
      parseExternalAcpRegistrations(
        { version: 1, agents: [entry, { ...entry, agent: 'team-agent' }] },
        ['codex']
      ).ok
    ).toBe(true)
  })
  it.each([
    { version: 1, agents: [{ ...entry, agent: 'codex' }] },
    { version: 1, agents: [entry, entry] },
    { version: 1, agents: [{ ...entry, command: 'hermes' }] },
    { version: 1, agents: [{ ...entry, shell: true }] },
    { version: 2, agents: [entry] },
    { version: 1, agents: [{ ...entry, agent: '../bad' }] },
    { version: 1, agents: [{ ...entry, args: ['\0'] }] }
  ])('rejects invalid configuration without returning raw input', (value) => {
    expect(parseExternalAcpRegistrations(value, ['codex'])).toEqual({
      ok: false,
      error: 'invalid-external-acp-registration'
    })
  })
})
