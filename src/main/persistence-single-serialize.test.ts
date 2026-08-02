// Why this file exists: persistence.test.ts mocks safeStorage.encryptString
// deterministically, which cannot catch the real-world hazard the single-
// stringify save guard must survive — encrypt() uses a random IV, so identical
// state produces different on-disk bytes each save. These tests mock a
// nondeterministic cipher and pin the guard + payload invariants.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const testState = { dir: '' }

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

// Nondeterministic cipher: same plaintext → different ciphertext every call,
// like safeStorage's random IV. encryptionAvailable is toggleable per test.
// deterministic=true mimics macOS/legacy-Linux OSCrypt (constant IV → same
// plaintext always yields the same ciphertext), which is what makes the
// cross-field blob-collision reachable by a user.
const cipherState = { encryptionAvailable: true, deterministic: false }
const DETERMINISTIC_IV = 'd'.repeat(36)

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => cipherState.encryptionAvailable,
    encryptString: (plaintext: string) =>
      Buffer.from(
        `enc:${cipherState.deterministic ? DETERMINISTIC_IV : randomUUID()}:${plaintext}`,
        'utf-8'
      ),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('enc:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('enc:'.length + 36 + 1)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

const SECRETS = {
  opencodeSessionCookie: 'cookie-$&-value',
  httpProxyUrl: 'http://user:p@ss@proxy.local:8080'
} as const
const KAGI_LINK = 'https://kagi.com/session?token=abc123'

describe('persistence single-serialize save guard', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    cipherState.encryptionAvailable = true
    cipherState.deterministic = false
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  async function seedStoreWithSecrets() {
    const store = await createStore()
    store.updateSettings({ ...SECRETS })
    store.updateUI({ browserKagiSessionLink: KAGI_LINK })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    return store
  }

  it('skips the disk write when state is identical, even with secrets set (random-IV cipher)', async () => {
    const store = await seedStoreWithSecrets()
    const inoBefore = statSync(dataFile()).ino

    // Net no-op mutation burst: the encrypted payload bytes would differ
    // (random IV), but the normalized guard hash must not.
    const originalWidth = store.getUI().sidebarWidth
    store.updateUI({ sidebarWidth: 512 })
    store.updateUI({ sidebarWidth: originalWidth })
    store.updateSettings({ ...SECRETS })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()

    expect(statSync(dataFile()).ino).toBe(inoBefore)
  })

  it('still writes when state actually changes (including a secret change)', async () => {
    const store = await seedStoreWithSecrets()
    const inoBefore = statSync(dataFile()).ino

    store.updateSettings({ opencodeSessionCookie: 'rotated-cookie' })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    const inoAfter = statSync(dataFile()).ino
    expect(inoAfter).not.toBe(inoBefore)

    store.updateUI({ sidebarWidth: 777 })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    expect(statSync(dataFile()).ino).not.toBe(inoAfter)
  })

  it('writes encrypted secrets to disk and round-trips them through a reload', async () => {
    await seedStoreWithSecrets()

    const raw = readFileSync(dataFile(), 'utf-8')
    const persisted = JSON.parse(raw) as {
      settings: { opencodeSessionCookie: string; httpProxyUrl: string }
      ui: { browserKagiSessionLink: string }
    }
    // Secrets are ciphertext on disk, plaintext nowhere in the payload.
    expect(persisted.settings.opencodeSessionCookie).not.toBe(SECRETS.opencodeSessionCookie)
    expect(persisted.settings.httpProxyUrl).not.toBe(SECRETS.httpProxyUrl)
    expect(persisted.ui.browserKagiSessionLink).not.toBe(KAGI_LINK)
    expect(raw).not.toContain(SECRETS.opencodeSessionCookie)
    expect(raw).not.toContain(KAGI_LINK)

    const reloaded = await createStore()
    expect(reloaded.getSettings().opencodeSessionCookie).toBe(SECRETS.opencodeSessionCookie)
    expect(reloaded.getSettings().httpProxyUrl).toBe(SECRETS.httpProxyUrl)
    expect(reloaded.getUI().browserKagiSessionLink).toBe(KAGI_LINK)
  })

  it('handles empty secrets and unavailable encryption (payload stays plaintext, guard still skips)', async () => {
    cipherState.encryptionAvailable = false
    const store = await createStore()
    store.updateSettings({ ...SECRETS, opencodeSessionCookie: '' })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()

    const persisted = JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
      settings: { opencodeSessionCookie: string; httpProxyUrl: string }
    }
    expect(persisted.settings.opencodeSessionCookie).toBe('')
    expect(persisted.settings.httpProxyUrl).toBe(SECRETS.httpProxyUrl)

    const inoBefore = statSync(dataFile()).ino
    store.updateSettings({ httpProxyUrl: SECRETS.httpProxyUrl })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    expect(statSync(dataFile()).ino).toBe(inoBefore)
  })

  it('sync flush also skips on identical state with secrets set', async () => {
    const store = await seedStoreWithSecrets()
    const inoBefore = statSync(dataFile()).ino

    store.flushOrThrow()

    expect(statSync(dataFile()).ino).toBe(inoBefore)
  })

  it('performs exactly one full-state JSON.stringify per save (was two)', async () => {
    const store = await seedStoreWithSecrets()

    // Count full-state serializations: only the durable-state payload is
    // anywhere near this size in the save path (tiny stringifies elsewhere
    // stay far below the threshold).
    const original = JSON.stringify.bind(JSON)
    let fullStateSerializations = 0
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((
      value: unknown,
      ...rest: unknown[]
    ) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = original(value as any, ...(rest as [any?, any?]))
      if (typeof out === 'string' && out.length > 1_000) {
        fullStateSerializations++
      }
      return out
    }) as typeof JSON.stringify)
    try {
      store.updateUI({ sidebarWidth: 640 })
      vi.advanceTimersByTime(2000)
      await store.waitForPendingWrite()
    } finally {
      spy.mockRestore()
    }

    expect(fullStateSerializations).toBe(1)
  })

  // Regression (adversarial review, gpt-5.6-sol round 1): the guard hash
  // normalizes encrypted secrets back to plaintext. A user-controlled plaintext
  // VALUE (httpProxyBypassRules) can equal a secret's ciphertext; on a
  // deterministic cipher (macOS/legacy-Linux OSCrypt constant IV) a string
  // search for the ciphertext would substitute the wrong site, letting two
  // distinct states hash equal → a silently dropped write (data loss). The
  // position-exact sentinel substitution must keep the hashes distinct.
  it('persists a swap between a plaintext field and a secret when the plaintext equals the secret ciphertext (deterministic cipher)', async () => {
    cipherState.deterministic = true
    const store = await createStore()

    const P = 'cookie-plaintext-value'
    // Persist cookie=P, then read its on-disk ciphertext C (what a user could
    // copy out of orca-data.json).
    store.updateSettings({ opencodeSessionCookie: P })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    const C = (
      JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
        settings: { opencodeSessionCookie: string }
      }
    ).settings.opencodeSessionCookie
    expect(C).not.toBe(P) // C is ciphertext

    // State 1: the plaintext bypass-rules field literally holds ciphertext C;
    // cookie is still P (which also encrypts to C under the deterministic IV).
    store.updateSettings({ httpProxyBypassRules: C, opencodeSessionCookie: P })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    const inoState1 = statSync(dataFile()).ino

    // State 2 (distinct): swap the two values. Must be written, not skipped.
    store.updateSettings({ httpProxyBypassRules: P, opencodeSessionCookie: C })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    expect(statSync(dataFile()).ino).not.toBe(inoState1)

    // The swap round-trips through a reload — nothing was lost.
    const reloaded = await createStore()
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(P)
    expect(reloaded.getSettings().opencodeSessionCookie).toBe(C)
  })

  // Regression (adversarial review, gpt-5.6-sol round 2): the deeper variant of
  // the same class — a user-controlled JSON KEY. agentDefaultEnv lets the user
  // name an env var exactly after a secret field, so `"browserKagiSessionLink":
  // "<ciphertext>"` can appear (inside settings, before ui) as a non-secret
  // entry. A key-anchored string replace would substitute that site instead of
  // the real ui field. The per-slot sentinel is unguessable, so it only ever
  // matches the real secret slot and the two distinct states stay distinct.
  it('persists a swap when an agentDefaultEnv var is named after a secret field and holds its ciphertext (deterministic cipher)', async () => {
    cipherState.deterministic = true
    const store = await createStore()

    const K = 'https://kagi.com/session?token=SECRET'
    store.updateUI({ browserKagiSessionLink: K })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    const C = (
      JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
        ui: { browserKagiSessionLink: string }
      }
    ).ui.browserKagiSessionLink
    expect(C).not.toBe(K) // C is ciphertext

    // State 1: env var literally named after the secret field, value = C; the
    // real ui secret is still K.
    store.updateSettings({ agentDefaultEnv: { claude: { browserKagiSessionLink: C } } })
    store.updateUI({ browserKagiSessionLink: K })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    const inoState1 = statSync(dataFile()).ino

    // State 2 (distinct): swap — env var value = K, ui secret = C. Must write.
    store.updateSettings({ agentDefaultEnv: { claude: { browserKagiSessionLink: K } } })
    store.updateUI({ browserKagiSessionLink: C })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    expect(statSync(dataFile()).ino).not.toBe(inoState1)

    const reloaded = await createStore()
    expect(reloaded.getSettings().agentDefaultEnv?.claude?.browserKagiSessionLink).toBe(K)
    expect(reloaded.getUI().browserKagiSessionLink).toBe(C)
  })
})
