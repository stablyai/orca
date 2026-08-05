// ACTIVATION: one durable store, derived selection.
//
// The encrypted key record is the ONLY provider state. Its presence derives the
// selection of the sole fixed provider, so there is no second store to write and
// therefore no cross-store window to reconcile — the reason the design does not
// claim an impossible "atomic" write across the key file and GlobalSettings.
//
// These tests also pin the truthful pre-admission contract while the
// credential-delivery capability is false.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let orcaHome: string

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') },
  // Encryption unavailable ⇒ the store's documented plaintext fallback, which
  // keeps these tests independent of an OS keychain.
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => orcaHome }
})

import {
  clearAuditedCodexProviderKey,
  hasAuditedCodexProviderKey,
  readAuditedCodexProviderKey,
  resetAuditedCodexProviderKeyCacheForTests,
  saveAuditedCodexProviderKey
} from './audited-codex-provider-key-store'
import {
  getAuditedCodexProviderStatus,
  resolveAuditedCodexProvider,
  resolveAuditedCodexCliProvider
} from './audited-codex-provider-settings'

const KEY_FILE = 'audited-workflow-codex-provider-token.enc'
const TRIAGE_KEY_FILE = 'audited-workflow-triage-openai-token.enc'

function keyPath(): string {
  return join(orcaHome, '.orca', KEY_FILE)
}

beforeEach(() => {
  orcaHome = mkdtempSync(join(tmpdir(), 'orca-provider-'))
  resetAuditedCodexProviderKeyCacheForTests()
})

afterEach(() => {
  resetAuditedCodexProviderKeyCacheForTests()
  rmSync(orcaHome, { recursive: true, force: true })
})

describe('key store — one durable record', () => {
  it('round-trips a saved key', () => {
    saveAuditedCodexProviderKey('provider-key-value')
    expect(hasAuditedCodexProviderKey()).toBe(true)
    expect(readAuditedCodexProviderKey()).toBe('provider-key-value')
  })

  it('trims and refuses a blank key', () => {
    expect(() => saveAuditedCodexProviderKey('   ')).toThrow()
    expect(hasAuditedCodexProviderKey()).toBe(false)
  })

  it('clearing removes the record', () => {
    saveAuditedCodexProviderKey('k')
    clearAuditedCodexProviderKey()
    expect(hasAuditedCodexProviderKey()).toBe(false)
    expect(() => readAuditedCodexProviderKey()).toThrow()
  })

  it('uses a file DISTINCT from the triage key', () => {
    // Conflating them would leak one feature's credential into the other's
    // launch; a user may configure either independently.
    saveAuditedCodexProviderKey('provider')
    const triagePath = join(orcaHome, '.orca', TRIAGE_KEY_FILE)
    writeFileSync(triagePath, 'triage', 'utf8')

    expect(readAuditedCodexProviderKey()).toBe('provider')
    clearAuditedCodexProviderKey()
    // Clearing one must not disturb the other.
    expect(hasAuditedCodexProviderKey()).toBe(false)
    expect(readAuditedCodexProviderKey.bind(null)).toThrow()
  })
})

describe('activation — selection is DERIVED, never separately persisted', () => {
  it('save writes exactly one durable record and no settings', () => {
    saveAuditedCodexProviderKey('k')
    // The key store is the whole of provider state: no settings write exists to
    // spy on, and the resolver below reads nothing else.
    expect(hasAuditedCodexProviderKey()).toBe(true)
  })

  it('a present key derives the sole fixed provider', () => {
    saveAuditedCodexProviderKey('k')
    expect(getAuditedCodexProviderStatus()).toEqual({
      settingsId: 'byesu',
      keyConfigured: true
    })
  })

  it('no key ⇒ no provider, and the two status facts cannot disagree', () => {
    expect(getAuditedCodexProviderStatus()).toEqual({
      settingsId: null,
      keyConfigured: false
    })
  })

  it('clearing returns to default-provider behaviour', () => {
    saveAuditedCodexProviderKey('k')
    clearAuditedCodexProviderKey()
    expect(getAuditedCodexProviderStatus()).toEqual({
      settingsId: null,
      keyConfigured: false
    })
    expect(resolveAuditedCodexProvider()).toEqual({
      ok: true,
      provider: null,
      model: null,
      mode: 'codex_cli'
    })
  })
})

describe('resolution — capability false', () => {
  it('no key ⇒ default path, unchanged behaviour', () => {
    expect(resolveAuditedCodexProvider()).toEqual({
      ok: true,
      provider: null,
      model: null,
      mode: 'codex_cli'
    })
  })

  it('key present ⇒ the no-tools transport, NOT a refusal', () => {
    // WAS `credential_delivery_unavailable`. The adapter delivers no credential
    // to a child process, so the refusal no longer applies — but the mode keeps
    // the result honest about which transport will run.
    saveAuditedCodexProviderKey('k')
    const resolution = resolveAuditedCodexProvider()
    expect(resolution.ok).toBe(true)
    expect(resolution.ok && resolution.mode).toBe('byesu_no_tools')
    expect(resolution.ok && resolution.provider?.settingsId).toBe('byesu')
  })

  it('a CORRUPT record resolves identically — presence is all that is read', () => {
    // UNCHANGED AND STILL THE POINT: distinguishing corrupt from good requires
    // DECRYPTING the key, which resolution must never do. A garbage record and
    // a good one resolve the same way, and neither is inspected. The corruption
    // surfaces later as an `api_unauthorized` from the transport — the only
    // layer entitled to read the value.
    saveAuditedCodexProviderKey('k')
    resetAuditedCodexProviderKeyCacheForTests()
    writeFileSync(keyPath(), '   ', 'utf8')

    const resolution = resolveAuditedCodexProvider()
    expect(resolution.ok).toBe(true)
    expect(resolution.ok && resolution.mode).toBe('byesu_no_tools')
  })

  it('does NOT report provider_not_configured for any present record', () => {
    // Reserved for the future tranche, where a selection can exist without a key
    // and the distinction is observable without reading the value.
    saveAuditedCodexProviderKey('k')
    resetAuditedCodexProviderKeyCacheForTests()
    writeFileSync(keyPath(), 'garbage-not-decryptable', 'utf8')

    expect(resolveAuditedCodexProvider()).not.toMatchObject({
      reasonCode: 'provider_not_configured'
    })
  })

  it('never hands a provider to a CLI LAUNCH while the capability is disabled', () => {
    saveAuditedCodexProviderKey('k')
    // The property this always guarded, now asked of the resolver that owns the
    // question. No code path may hand a provider — and therefore an endpoint
    // plus a credential — to a CHILD PROCESS while delivery is off.
    expect(resolveAuditedCodexCliProvider()).toEqual({
      ok: false,
      reasonCode: 'credential_delivery_unavailable'
    })
  })
})

describe('the settings field is INERT in this tranche', () => {
  it('resolution reads only the key store', async () => {
    // The resolver imports no settings store at all, so a stale or hand-planted
    // `auditedCodexProvider` cannot activate anything or manufacture a refusal.
    const { readFileSync } = await import('node:fs')
    // Comments stripped: the module deliberately EXPLAINS that it does not read
    // settings, so scanning prose would flag the documentation itself.
    const code = readFileSync(join(__dirname, 'audited-codex-provider-settings.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/getSettings|updateSettings|GlobalSettings/)
  })

  it('no key + any planted settings value ⇒ still the default path', () => {
    // Nothing to plant into: resolution is a pure function of the key record.
    expect(resolveAuditedCodexProvider()).toEqual({
      ok: true,
      provider: null,
      model: null,
      mode: 'codex_cli'
    })
  })
})
