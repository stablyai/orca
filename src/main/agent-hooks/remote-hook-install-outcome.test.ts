import { describe, expect, it } from 'vitest'
import { readManagedHookInstallOutcome } from './remote-hook-install-outcome'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

function status(
  agent: AgentHookInstallStatus['agent'],
  state: AgentHookInstallStatus['state'],
  detail: string | null = null
): AgentHookInstallStatus {
  return { agent, state, configPath: `/home/dev/.${agent}`, managedHooksPresent: true, detail }
}

describe('readManagedHookInstallOutcome', () => {
  it('reports installed when every agent installed on that host', () => {
    const outcome = readManagedHookInstallOutcome({
      installers: 2,
      errors: 0,
      statuses: [status('claude', 'installed'), status('codex', 'installed')]
    })
    expect(outcome.state).toBe('installed')
    expect(outcome.statuses.map((entry) => entry.agent)).toEqual(['claude', 'codex'])
  })

  it('reports partial and keeps the failing agent visible', () => {
    const outcome = readManagedHookInstallOutcome({
      installers: 2,
      errors: 1,
      statuses: [
        status('claude', 'installed'),
        status('codex', 'error', 'Could not parse remote Codex hooks.json')
      ]
    })
    expect(outcome.state).toBe('partial')
    expect(outcome.detail).toContain('1 agent hook install(s) failed')
    expect(outcome.statuses.find((entry) => entry.agent === 'codex')?.detail).toBe(
      'Could not parse remote Codex hooks.json'
    )
  })

  it('never calls a host installed when Codex did not install there', () => {
    const outcome = readManagedHookInstallOutcome({
      installers: 2,
      errors: 0,
      statuses: [status('claude', 'installed'), status('codex', 'not_installed')]
    })
    expect(outcome.state).not.toBe('installed')
    expect(outcome.state).toBe('partial')
  })

  it('reports skipped when the host installed nothing at all', () => {
    expect(readManagedHookInstallOutcome({ installers: 0, errors: 0 }).state).toBe('skipped')
  })

  it('falls back to counts from a relay that predates the per-agent field', () => {
    const outcome = readManagedHookInstallOutcome({ installers: 3, errors: 1 })
    expect(outcome.state).toBe('partial')
    expect(outcome.statuses).toEqual([])
    expect(outcome.detail).toContain('1 of 3')
  })

  it('reports unknown — never installed — when the relay says nothing usable', () => {
    for (const result of [null, undefined, {}, { statuses: 'nope' }, 'garbage']) {
      expect(readManagedHookInstallOutcome(result).state).toBe('unknown')
    }
  })

  it('drops malformed status entries instead of trusting them', () => {
    const outcome = readManagedHookInstallOutcome({
      installers: 1,
      errors: 0,
      statuses: [{ agent: 'not-an-agent', state: 'installed' }, { state: 'installed' }]
    })
    expect(outcome.state).toBe('unknown')
    expect(outcome.statuses).toEqual([])
  })
})
