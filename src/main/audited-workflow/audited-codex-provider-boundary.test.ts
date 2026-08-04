// MODULE OWNERSHIP: authority in main, DTOs in shared.
//
// `src/shared` is reachable from preload and the renderer, so publishing the
// endpoint or the Codex-side provider configuration there would hand the very
// layer the design keeps them away from everything it needs to redirect a
// credential. Placement IS the boundary, so it is asserted rather than assumed.
//
// Mirrors the AUDITED_PROJECTION_FORBIDDEN_KEYS runtime-denylist idiom: scan the
// real source, so a future import that drags authority into shared fails here
// instead of silently shipping.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as sharedProviderTypes from '../../shared/audited-codex-provider-types'

const SHARED_MODULE = join(__dirname, '..', '..', 'shared', 'audited-codex-provider-types.ts')

function readSharedSource(): string {
  return readFileSync(SHARED_MODULE, 'utf8')
}

/** Strips comments so the assertions test CODE, not prose explaining the rule. */
function readSharedCode(): string {
  return readSharedSource()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('shared provider module carries no authority', () => {
  it.each([
    ['the endpoint host', 'byesu.com'],
    ['a Codex-side provider id', 'orcaAuditedByesu'],
    ['the env var name', 'ORCA_AUDITED_CODEX_API_KEY'],
    ['the registry', 'AUDITED_CODEX_PROVIDERS'],
    ['the capability constant', 'AUDITED_CODEX_CREDENTIAL_DELIVERY_ENABLED']
  ])('does not contain %s', (_label, literal) => {
    expect(readSharedCode()).not.toContain(literal)
  })

  it('exports no endpoint, wire api, env key, or registry value at runtime', () => {
    const exported = Object.keys(sharedProviderTypes)
    expect(exported).not.toContain('AUDITED_CODEX_PROVIDERS')
    expect(exported).not.toContain('AUDITED_CODEX_ENV_KEY')
    expect(exported).not.toContain('AUDITED_CODEX_WIRE_APIS')
    expect(exported).not.toContain('resolveRegistryEntry')
    // Nothing exported may be, or contain, a URL.
    const serialized = JSON.stringify(
      Object.values(sharedProviderTypes).filter((value) => typeof value !== 'function')
    )
    expect(serialized).not.toContain('http')
  })

  it('exports exactly the safe settings-id vocabulary', () => {
    // The one part the renderer legitimately types against: an opaque selector
    // that carries no endpoint and cannot be resolved to one outside main.
    expect([...sharedProviderTypes.AUDITED_CODEX_SETTINGS_IDS]).toEqual(['byesu'])
  })

  it('does not import from the main process', () => {
    // A main-side import would drag the registry into the renderer bundle even
    // if this file never named a literal.
    expect(readSharedCode()).not.toMatch(/from\s+['"].*\/main\//)
  })
})

describe('main registry keeps the authority', () => {
  it('declares AUDITED_CODEX_ENV_KEY before the definition type and registry', async () => {
    // Declaration order is load-bearing: both the type and the registry
    // reference the constant, so declaring it later is a temporal-dead-zone
    // ReferenceError at module evaluation.
    const source = readFileSync(join(__dirname, 'audited-codex-provider-registry.ts'), 'utf8')
    const envKeyAt = source.indexOf('export const AUDITED_CODEX_ENV_KEY')
    const typeAt = source.indexOf('export type AuditedCodexProviderDefinition')
    const registryAt = source.indexOf('export const AUDITED_CODEX_PROVIDERS')

    expect(envKeyAt).toBeGreaterThan(-1)
    expect(envKeyAt).toBeLessThan(typeAt)
    expect(envKeyAt).toBeLessThan(registryAt)

    // And it evaluates without throwing, which is what the ordering protects.
    const registry = await import('./audited-codex-provider-registry')
    expect(registry.AUDITED_CODEX_PROVIDERS.byesu.envKey).toBe(registry.AUDITED_CODEX_ENV_KEY)
  })

  it('ships credential delivery DISABLED', async () => {
    const registry = await import('./audited-codex-provider-registry')
    // The capability that gates every credential-delivery artifact. Flipping it
    // is a reviewed change carrying the all-platform propagation evidence.
    expect(registry.AUDITED_CODEX_CREDENTIAL_DELIVERY_ENABLED).toBe(false)
  })
})
