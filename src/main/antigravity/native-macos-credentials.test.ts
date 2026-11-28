import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { fingerprintAntigravityMacOSCredential } from './native-macos-credentials'

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
  const first = await fingerprintAntigravityMacOSCredential()
  expect(await fingerprintAntigravityMacOSCredential()).toBe(first)
  expect(await fingerprintAntigravityMacOSCredential()).not.toBe(first)
  expect(await fingerprintAntigravityMacOSCredential()).toBeNull()
  // -w (or -g) would read the secret, which can raise the keychain's access dialog.
  for (const [spec] of vi.mocked(runProcess).mock.calls) {
    expect(spec.args).not.toContain('-w')
    expect(spec.args).not.toContain('-g')
  }
})
