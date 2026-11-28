import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  AntigravityKeychainAccessError,
  readAntigravityMacOSCredentialRevision,
  writeAntigravityMacOSCredential
} from './native-macos-credentials'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))

// `security find-generic-password` without -w, as macOS 15 prints it (trimmed).
const attributes = (mdat: string) =>
  `keychain: "/Users/someone/Library/Keychains/login.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>="antigravity"\n    "mdat"<timedate>=0x00  "${mdat}Z\\000"\n    "svce"<blob>="gemini"\n`

function answer(result: { code: number | null; stdout?: string; timedOut?: boolean }) {
  vi.mocked(runProcess).mockResolvedValueOnce({
    signal: null,
    stderr: '',
    stdout: '',
    timedOut: false,
    ...result
  })
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.mocked(runProcess).mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

it('fingerprints agy’s keychain item from its attributes alone, changing when agy rewrites it', async () => {
  answer({ code: 0, stdout: attributes('20261127235448') })
  answer({ code: 0, stdout: attributes('20261127235448') })
  answer({ code: 0, stdout: attributes('20261127235449') })
  answer({ code: 44 })
  const first = await readAntigravityMacOSCredentialRevision()
  // mdat counts whole seconds: a write later in 23:54:48 would keep this fingerprint.
  expect(first).toMatchObject({ stableFrom: Date.UTC(2026, 10, 27, 23, 54, 49), settled: true })
  expect((await readAntigravityMacOSCredentialRevision())?.fingerprint).toBe(first?.fingerprint)
  expect((await readAntigravityMacOSCredentialRevision())?.fingerprint).not.toBe(first?.fingerprint)
  expect(await readAntigravityMacOSCredentialRevision()).toBeNull()
  // -w (or -g) would read the secret, which can raise the keychain's access dialog.
  for (const [spec] of vi.mocked(runProcess).mock.calls) {
    expect(spec.args).not.toContain('-w')
    expect(spec.args).not.toContain('-g')
  }
})

it('reports a refused or unanswered keychain write as keychain access, and other failures as not', async () => {
  const login = JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer' })
  for (const code of [36, 51, 128]) {
    answer({ code })
    await expect(writeAntigravityMacOSCredential(login)).rejects.toBeInstanceOf(
      AntigravityKeychainAccessError
    )
  }
  answer({ code: 1 })
  const other = await writeAntigravityMacOSCredential(login).catch((error: unknown) => error)
  expect(other).not.toBeInstanceOf(AntigravityKeychainAccessError)
})
