// PHASE 11 §3a — the contract that makes the S11 inert fixture valid.
//
// S11 asserts that a Byesu-configured task refuses with exactly
// `credential_delivery_unavailable`. To produce that WITHOUT a real credential,
// the release harness writes a ZERO-BYTE file at the provider-key path. That is
// only legitimate while presence detection stays presence-ONLY: an `existsSync`
// on an opaque file that is never opened, decrypted, or parsed.
//
// THIS FILE IS THE TRIPWIRE. If a future revision makes presence detection read
// or validate the record, these tests fail FIRST — before the packaged smoke
// starts passing for the wrong reason, or worse, starts demanding a real key.
// When that happens the plan's documented fallback applies: S11 is demoted from
// a required packaged gate to a mocked contract test, and the release matrix
// records the refusal as verified in-process only.
//
// Nothing here writes, reads, decrypts, masks, or logs a credential value. The
// only artifact is an empty file, which carries no secret material by
// construction.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let orcaHome: string
let decryptCalls = 0

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') },
  safeStorage: {
    // Encryption AVAILABLE, deliberately: this is the configuration in which a
    // zero-byte record would be undecryptable. If any code path tried to read
    // the value, decryptString would be called and these counters would prove
    // it — which is exactly the failure mode the fixture must not have.
    isEncryptionAvailable: () => true,
    encryptString: () => {
      throw new Error('encryptString must never be called by the inert fixture path')
    },
    decryptString: () => {
      decryptCalls += 1
      throw new Error('decryptString must never be called by the inert fixture path')
    }
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => orcaHome }
})

import {
  hasAuditedCodexProviderKey,
  resetAuditedCodexProviderKeyCacheForTests
} from './audited-codex-provider-key-store'
import {
  getAuditedCodexProviderStatus,
  resolveAuditedCodexProvider,
  resolveAuditedCodexCliProvider
} from './audited-codex-provider-settings'

const KEY_FILE = 'audited-workflow-codex-provider-token.enc'

function keyPath(): string {
  return join(orcaHome, '.orca', KEY_FILE)
}

/**
 * Writes the S11 fixture EXACTLY as the release harness does: zero bytes, mode
 * 0600, placed directly rather than via saveAuditedCodexProviderKey.
 *
 * Going through the save path would encrypt a value — the one thing the fixture
 * exists to avoid.
 */
function writeInertProviderRecord(): void {
  mkdirSync(join(orcaHome, '.orca'), { recursive: true })
  writeFileSync(keyPath(), Buffer.alloc(0), { mode: 0o600 })
}

beforeEach(() => {
  orcaHome = mkdtempSync(join(tmpdir(), 'orca-inert-fixture-'))
  decryptCalls = 0
  resetAuditedCodexProviderKeyCacheForTests()
})

afterEach(() => {
  resetAuditedCodexProviderKeyCacheForTests()
  rmSync(orcaHome, { recursive: true, force: true })
})

describe('the inert fixture is genuinely inert', () => {
  it('is zero bytes on disk', () => {
    writeInertProviderRecord()
    expect(statSync(keyPath()).size).toBe(0)
  })

  it('carries no secret material — an empty file cannot encode one', () => {
    writeInertProviderRecord()
    expect(existsSync(keyPath())).toBe(true)
    expect(statSync(keyPath()).size).toBe(0)
  })
})

describe('presence detection is presence-ONLY (the S11 precondition)', () => {
  it('treats a zero-byte record as PRESENT', () => {
    // THE LOAD-BEARING ASSERTION. If this ever fails, the zero-byte fixture no
    // longer reaches the refusal branch and S11 must be demoted per §3a.
    expect(hasAuditedCodexProviderKey()).toBe(false)
    writeInertProviderRecord()
    expect(hasAuditedCodexProviderKey()).toBe(true)
  })

  it('never decrypts while detecting presence', () => {
    writeInertProviderRecord()
    hasAuditedCodexProviderKey()
    expect(decryptCalls).toBe(0)
  })
})

describe('the inert record resolves without any credential being read', () => {
  it('resolves to the no-tools transport', () => {
    // WAS `credential_delivery_unavailable`, the S11 expected-blocked outcome.
    // The no-tools adapter needs no credential DELIVERY — it spawns nothing —
    // so a present record now admits an audit instead of refusing.
    //
    // WHAT THIS FILE STILL GUARDS IS UNCHANGED AND IS THE WHOLE POINT: the
    // resolution path reaches its answer WITHOUT DECRYPTING. The zero-byte
    // fixture is still never read, which is why it remains safe to plant in CI.
    writeInertProviderRecord()
    const result = resolveAuditedCodexProvider()

    expect(result.ok).toBe(true)
    expect(result.ok && result.mode).toBe('byesu_no_tools')
  })

  it.each([['provider_not_configured'], ['provider_storage_unavailable']])(
    'is never the negative-control code %s',
    (forbidden) => {
      // Still the two plausible-but-wrong outcomes, and both are still release
      // BLOCKERS: `provider_not_configured` would misreport the user's own
      // state, and `provider_storage_unavailable` would mean the presence probe
      // threw. Neither may appear for a well-formed present record.
      writeInertProviderRecord()
      const result = resolveAuditedCodexProvider()

      expect(result.ok === false && result.reasonCode).not.toBe(forbidden)
    }
  )

  it('an inert record STILL cannot reach a Codex CLI launch', () => {
    // The Tranche 2 gate, unchanged. A zero-byte record must never be handed to
    // a child process, and the CLI resolver is what refuses.
    writeInertProviderRecord()
    expect(resolveAuditedCodexCliProvider()).toEqual({
      ok: false,
      reasonCode: 'credential_delivery_unavailable'
    })
    expect(decryptCalls).toBe(0)
  })

  it('reaches the refusal without decrypting anything', () => {
    writeInertProviderRecord()
    resolveAuditedCodexProvider()
    expect(decryptCalls).toBe(0)
  })

  it('reports the provider as CONFIGURED, so the refusal is not "no provider"', () => {
    // S11's premise: the user HAS configured a provider. If status reported
    // "not configured" the scenario would be testing the wrong thing entirely.
    writeInertProviderRecord()
    const status = getAuditedCodexProviderStatus()
    expect(status.keyConfigured).toBe(true)
    // Selection is DERIVED from the record, so a present record also selects
    // the sole fixed provider — the state S11 needs a task to be in.
    expect(status.settingsId).toBe('byesu')
  })

  it('still reports NOT configured with no record at all — the contrast case', () => {
    expect(getAuditedCodexProviderStatus().keyConfigured).toBe(false)
    const result = resolveAuditedCodexProvider()
    // No record ⇒ no custom provider, which is a SUCCESS with a null provider,
    // never the delivery refusal. Pinning it keeps the two states distinct.
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.provider).toBeNull()
  })
})
