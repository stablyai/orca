import { describe, expect, it } from 'vitest'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AgentModelCatalogFailures,
  AgentModelCatalogListingStoppedError
} from './agent-model-catalog-failures'
import { AgentModelCatalogUnavailableError } from './agent-model-catalog-unavailable'

describe('agent model catalog failures', () => {
  it('classifies missing CLI executable as cliMissing unavailable reason', () => {
    let now = 1_000
    const failures = new AgentModelCatalogFailures(() => now)
    const error = Object.assign(new Error('spawn grok ENOENT'), {
      name: 'AgentModelCatalogProbeError',
      reason: 'spawn',
      executableMissing: true
    })

    failures.probeFailed('fp-grok', 'grok', error)

    const failure = failures.get('fp-grok')
    expect(failure).not.toBeNull()
    expect(failure?.agent).toBe('grok')
    expect(failure?.detail).toBe('spawn grok ENOENT')
    expect(failure?.unavailable).toEqual({ reason: 'cliMissing' })
  })

  it('records AgentModelCatalogUnavailableError with notSignedIn reason', () => {
    let now = 2_000
    const failures = new AgentModelCatalogFailures(() => now)
    const error = new AgentModelCatalogUnavailableError({ reason: 'notSignedIn' })

    failures.probeFailed('fp-claude', 'claude', error)

    const failure = failures.get('fp-claude')
    expect(failure?.unavailable).toEqual({ reason: 'notSignedIn' })
  })

  it('records generic probe errors without unavailable property', () => {
    let now = 3_000
    const failures = new AgentModelCatalogFailures(() => now)
    const error = new Error('network timeout connecting to provider')

    failures.probeFailed('fp-codex', 'codex', error)

    const failure = failures.get('fp-codex')
    expect(failure?.detail).toBe('network timeout connecting to provider')
    expect(failure?.unavailable).toBeUndefined()
  })

  it('clears failures on successful probe listing', () => {
    let now = 4_000
    const failures = new AgentModelCatalogFailures(() => now)
    const error = new Error('temporary failure')

    failures.probeFailed('fp-opencode', 'opencode', error)
    expect(failures.get('fp-opencode')).not.toBeNull()

    failures.listed('fp-opencode', 'opencode', 'probe', undefined)
    expect(failures.get('fp-opencode')).toBeNull()
  })

  it('expires failures after failure TTL unless unavailable reason is present', () => {
    let now = 10_000
    const failures = new AgentModelCatalogFailures(() => now)
    failures.probeFailed('fp-generic', 'grok', new Error('timeout'))
    failures.probeFailed(
      'fp-missing',
      'grok',
      Object.assign(new Error('spawn grok ENOENT'), { executableMissing: true })
    )

    expect(failures.isActive('fp-generic')).toBe(true)
    expect(failures.isActive('fp-missing')).toBe(true)

    now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS + 1

    expect(failures.isActive('fp-generic')).toBe(false)
    expect(failures.get('fp-generic')).toBeNull()

    // Unavailable reason is retained past TTL until next probe replaces it
    expect(failures.isActive('fp-missing')).toBe(false)
    expect(failures.unavailableDue('fp-missing')).toBe(true)
  })

  it('allows instantiating AgentModelCatalogListingStoppedError with custom message', () => {
    const error = new AgentModelCatalogListingStoppedError("opencode lists in a chat's folder")
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe("opencode lists in a chat's folder")
  })
})
