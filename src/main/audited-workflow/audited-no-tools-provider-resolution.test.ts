// The Byesu refusal becomes a working no-tools path — and ONLY that.
//
// The inert-fixture test (audited-codex-provider-inert-fixture.test.ts) pinned
// the OLD behaviour: a present key record produced `credential_delivery_unavailable`.
// This file pins the new one, and pins that the CLI question still answers no.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const keyState = { present: false, throws: false }

vi.mock('./audited-codex-provider-key-store', () => ({
  hasAuditedCodexProviderKey: () => {
    if (keyState.throws) {
      throw new Error('EACCES')
    }
    return keyState.present
  },
  // Present so the module resolves, but a call is a TEST FAILURE: resolution
  // must branch on opaque PRESENCE and never read the value.
  readAuditedCodexProviderKey: () => {
    throw new Error('resolution must never read the key value')
  }
}))

const {
  resolveAuditedCodexProvider,
  resolveAuditedCodexCliProvider,
  getAuditedCodexProviderStatus
} = await import('./audited-codex-provider-settings')

beforeEach(() => {
  keyState.present = false
  keyState.throws = false
})

describe('a configured provider now resolves to the no-tools transport', () => {
  it('no longer refuses with credential_delivery_unavailable', () => {
    keyState.present = true

    const resolution = resolveAuditedCodexProvider()

    expect(resolution.ok).toBe(true)
    expect(resolution.ok && resolution.mode).toBe('byesu_no_tools')
    expect(resolution.ok && resolution.provider?.settingsId).toBe('byesu')
  })

  it('still reports the provider as configured', () => {
    keyState.present = true
    expect(getAuditedCodexProviderStatus()).toEqual({
      settingsId: 'byesu',
      keyConfigured: true
    })
  })
})

describe('the unconfigured and unreadable paths are unchanged', () => {
  it('resolves to the built-in default when no record exists', () => {
    const resolution = resolveAuditedCodexProvider()
    expect(resolution.ok).toBe(true)
    expect(resolution.ok && resolution.provider).toBeNull()
    // The CLI mode: a task with no custom provider runs the Phase 5/7 path.
    expect(resolution.ok && resolution.mode).toBe('codex_cli')
  })

  it('refuses when the presence probe itself fails', () => {
    keyState.throws = true
    // Unchanged: an unanswerable probe is not a licence to guess either way.
    expect(resolveAuditedCodexProvider()).toEqual({
      ok: false,
      reasonCode: 'provider_storage_unavailable'
    })
  })
})

describe('credential delivery to a child process stays closed', () => {
  it('the CLI resolver still refuses a configured provider', () => {
    keyState.present = true
    // THE TRANCHE 2 GATE. The adapter needs no credential delivery because it
    // spawns nothing; handing the same secret to Codex CLI is still refused.
    expect(resolveAuditedCodexCliProvider()).toEqual({
      ok: false,
      reasonCode: 'credential_delivery_unavailable'
    })
  })

  it('the CLI resolver is unaffected when no key exists', () => {
    const resolution = resolveAuditedCodexCliProvider()
    expect(resolution.ok).toBe(true)
    expect(resolution.ok && resolution.mode).toBe('codex_cli')
  })
})
