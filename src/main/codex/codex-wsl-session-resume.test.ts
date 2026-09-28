import { beforeEach, expect, it, vi } from 'vitest'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import { prepareCapturedWslCodexSessionResume } from './codex-wsl-session-resume'
import { probeCodexWslResumeFiles } from './codex-wsl-resume-file-probe'
vi.mock('./codex-wsl-resume-file-probe', () => ({ probeCodexWslResumeFiles: vi.fn() }))
const owner = { distro: 'Ubuntu', userName: 'alice', userId: '1000', home: '/home/alice' }
const id = '11111111-2222-3333-4444-555555555555'
const a = '/home/alice/accounts/a',
  b = '/home/alice/accounts/b'
const rollout = (home: string) => `${home}/sessions/2026/09/27/rollout-2026-${id}.jsonl`
const account = (home: string, id: string): CodexManagedAccount => ({
  id,
  managedHomePath: toWindowsWslUncPath(home, 'Ubuntu'),
  managedHomeRuntime: 'wsl',
  wslDistro: 'Ubuntu',
  wslLinuxHomePath: home,
  email: 'test@example.com',
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
})
const prepare = (transcriptPath?: string) =>
  prepareCapturedWslCodexSessionResume({
    execution: owner,
    target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
    providerSession: { key: 'session_id', id, transcriptPath },
    accounts: [account(a, 'a'), account(b, 'b')],
    selectedAccountId: 'b'
  })
beforeEach(() => {
  vi.mocked(probeCodexWslResumeFiles).mockReset()
})
it.each([false, true])(
  'pins verified transcript origin rather than currently selected account (UNC=%s)',
  async (unc) => {
    vi.mocked(probeCodexWslResumeFiles).mockResolvedValue(new Set([rollout(a)]))
    expect(await prepare(unc ? toWindowsWslUncPath(rollout(a), 'Ubuntu') : rollout(a))).toEqual({
      outcome: 'resume',
      codexHomePath: a
    })
  }
)
it('does not fall back to another account after claimed provenance becomes unavailable', async () => {
  vi.mocked(probeCodexWslResumeFiles).mockResolvedValue(new Set([rollout(b)]))
  expect(await prepare(rollout(a))).toEqual({ outcome: 'fresh', claimedCodexProvenance: true })
})
it('reuses selected-account ranking only for legacy metadata with no transcript', async () => {
  vi.mocked(probeCodexWslResumeFiles).mockResolvedValue(new Set([rollout(a), rollout(b)]))
  expect(await prepare()).toEqual({ outcome: 'resume', codexHomePath: b })
})
it.each([
  toWindowsWslUncPath(rollout(a), 'Debian'),
  rollout('/home/bob/.codex'),
  rollout('/home/alice/../bob/.codex')
])('refuses foreign or noncanonical transcript %s before guest I/O', async (path) => {
  expect(await prepare(path)).toEqual({ outcome: 'fresh', claimedCodexProvenance: true })
  expect(probeCodexWslResumeFiles).not.toHaveBeenCalled()
})
it('refuses an unverified selected home without substituting system default', async () => {
  await expect(
    prepareCapturedWslCodexSessionResume({
      execution: owner,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      providerSession: { key: 'session_id', id },
      accounts: [account('/home/bob/.codex', 'b')],
      selectedAccountId: 'b'
    })
  ).rejects.toThrow('captured WSL owner')
})
it('pins execution identity before asynchronous verification', async () => {
  const execution = { ...owner }
  vi.mocked(probeCodexWslResumeFiles).mockImplementation(async (args) => {
    execution.home = '/home/bob'
    execution.userName = 'bob'
    expect(args.execution).toEqual(owner)
    expect(Object.isFrozen(args.execution)).toBe(true)
    return new Set([rollout(a)])
  })
  expect(
    await prepareCapturedWslCodexSessionResume({
      execution,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      providerSession: { key: 'session_id', id, transcriptPath: rollout(a) },
      accounts: [account(a, 'a')],
      selectedAccountId: 'a'
    })
  ).toEqual({ outcome: 'resume', codexHomePath: a })
})

it('refuses distinct Linux homes that shared Unicode normalization would merge', async () => {
  await expect(
    prepareCapturedWslCodexSessionResume({
      execution: owner,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      providerSession: { key: 'session_id', id },
      accounts: [account('/home/alice/caf\u00e9', 'a'), account('/home/alice/cafe\u0301', 'b')],
      selectedAccountId: 'b'
    })
  ).rejects.toThrow('ambiguous WSL path identities')
  expect(probeCodexWslResumeFiles).not.toHaveBeenCalled()
})
