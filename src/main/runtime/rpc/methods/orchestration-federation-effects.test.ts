import { describe, expect, it } from 'vitest'
import {
  appendFederationSetupEffect,
  appendFederationTerminalEffects,
  type FederationEffect
} from './orchestration-federation-effects'

describe('orchestration federation effects', () => {
  it('uses exact terminal handles instead of display titles for setup identity', () => {
    const effects: FederationEffect[] = []

    appendFederationTerminalEffects(
      effects,
      [
        { handle: 'term_agent', title: 'Codex' },
        { handle: 'term_configured', title: 'Setup' },
        { handle: 'term_setup', title: 'PowerShell' }
      ],
      'term_agent',
      'term_setup'
    )
    appendFederationSetupEffect(effects, {
      requested: 'run',
      effective: 'run',
      source: 'orchestration_default',
      hookFound: true,
      startupPolicy: 'start-immediately',
      state: 'running'
    })

    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'term_configured', role: 'configured_tab' }),
        expect.objectContaining({ id: 'term_setup', role: 'setup' }),
        expect.objectContaining({ kind: 'setup', terminalId: 'term_setup' })
      ])
    )
  })
})
