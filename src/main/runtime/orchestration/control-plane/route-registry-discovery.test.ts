import { describe, expect, it } from 'vitest'
import {
  buildRouteRow,
  classifyIdentityProof,
  discoverReasoningModes,
  findRegistryDrift,
  isHookSupported,
  isLauncherSupported
} from './route-registry-discovery'

/** CORRECTION 1 — discovery reads the EXISTING authoritative catalogs. These
 *  tests therefore also document the exact installed truth this build found for
 *  each named certification target; none of them asserts a route is certified. */
describe('registry discovery consumes the authoritative catalogs', () => {
  it('reads launcher support from the Orca launcher config', () => {
    expect(isLauncherSupported('claude')).toBe(true)
    expect(isLauncherSupported('grok')).toBe(true)
    expect(isLauncherSupported('opencode')).toBe(true)
    expect(isLauncherSupported('not-an-agent')).toBe(false)
  })

  it('reads hook support from the managed agent-hook target list', () => {
    expect(isHookSupported('claude')).toBe(true)
    expect(isHookSupported('grok')).toBe(true)
    // Discovered truth at this SHA: OpenCode launches but is not a managed
    // agent-hook target, so any GLM route through it is a drift fault.
    expect(isHookSupported('opencode')).toBe(false)
  })

  it('treats a family alias as alias, an exact versioned id as exact, and an unknown id as UNKNOWN', () => {
    expect(classifyIdentityProof('claude', 'opus')).toBe('alias')
    expect(classifyIdentityProof('claude', 'fable')).toBe('alias')
    expect(classifyIdentityProof('grok', 'grok-4.6')).toBe('exact')
    expect(classifyIdentityProof('codex', 'gpt-5.6-sol')).toBe('exact')
    // Gemini 3.7 Flash is NOT in the installed Gemini catalog at this SHA.
    expect(classifyIdentityProof('gemini', 'gemini-3.7-flash')).toBe('UNKNOWN')
    expect(classifyIdentityProof('gemini', 'gemini-flash-latest')).toBe('UNKNOWN')
  })

  it('discovers reasoning modes from the catalog rather than declaring them', () => {
    expect(discoverReasoningModes('grok', 'grok-4.6').length).toBeGreaterThan(0)
    expect(discoverReasoningModes('gemini', 'gemini-3-pro-preview')).toEqual([])
  })

  it('leaves every unobservable fact as UNKNOWN on a freshly built row', () => {
    const row = buildRouteRow({ identity: { agent: 'grok', model: 'grok-4.6', reasoning: null } })
    expect(row.provider).toBe('UNKNOWN')
    expect(row.harness).toBe('UNKNOWN')
    expect(row.contextLimitTokens).toBe('UNKNOWN')
    expect(row.costClass).toBe('UNKNOWN')
    expect(row.readiness.availability).toBe('UNKNOWN')
    expect(row.readiness.quota.state).toBe('UNKNOWN')
    expect(row.readiness.quota.resetAt).toBe('UNKNOWN')
    // Discovery never grants a role or a capability.
    expect(row.roles).toEqual([])
    expect(row.taskCapabilities).toEqual([])
  })
})

describe('CORRECTION 1 launcher/hook drift gate', () => {
  it('fails a route that the launcher supports but the hook layer rejects', () => {
    const row = buildRouteRow({ identity: { agent: 'opencode', model: null, reasoning: null } })
    expect(row.launcherSupported).toBe(true)
    expect(row.hookSupported).toBe(false)
    expect(findRegistryDrift([row])).toEqual([
      expect.objectContaining({ code: 'launcher_supported_hook_rejected' })
    ])
  })

  it('fails a route whose model is absent from the authoritative catalog', () => {
    const row = buildRouteRow({
      identity: { agent: 'gemini', model: 'gemini-3.7-flash', reasoning: null }
    })
    expect(findRegistryDrift([row])).toEqual([
      expect.objectContaining({ code: 'model_absent_from_catalog' })
    ])
  })

  it('fails a route whose reasoning mode the catalog does not offer', () => {
    const row = buildRouteRow({
      identity: { agent: 'gemini', model: 'gemini-3-pro-preview', reasoning: 'ultra' }
    })
    expect(findRegistryDrift([row])).toEqual([
      expect.objectContaining({ code: 'reasoning_absent_from_catalog' })
    ])
  })

  it('negative control: a consistent route produces no drift fault', () => {
    const row = buildRouteRow({ identity: { agent: 'grok', model: 'grok-4.6', reasoning: null } })
    expect(findRegistryDrift([row])).toEqual([])
  })
})
