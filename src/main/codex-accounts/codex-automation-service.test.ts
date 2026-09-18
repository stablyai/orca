import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { createCodexAccountSettings } from './codex-account-settings-fixture'
import { CodexAutomationService } from './codex-automation-service'

const { fetchUsage, warm, panes } = vi.hoisted(() => ({
  fetchUsage: vi.fn(),
  warm: vi.fn(),
  panes: vi.fn(() => new Map())
}))
vi.mock('../rate-limits/codex-fetcher', () => ({ fetchCodexRateLimits: fetchUsage }))
vi.mock('./codex-warmup-inference', () => ({ warmCodexAccount: warm }))
vi.mock('../codex/codex-pane-account-registry', () => ({ listRecordedCodexPaneAccounts: panes }))

const account = (id: string, wslDistro?: string): CodexManagedAccount => ({
  id,
  email: `${id}@example.test`,
  managedHomePath: `/${id}`,
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1,
  managedHomeRuntime: wslDistro ? 'wsl' : 'host',
  wslDistro
})
function usage(usedPercent: number): ProviderRateLimits {
  const window = {
    usedPercent,
    windowMinutes: 300,
    resetsAt: Date.now() + 60_000,
    resetDescription: null
  }
  return {
    provider: 'codex',
    status: 'ok',
    error: null,
    updatedAt: Date.now(),
    session: window,
    weekly: window
  }
}
function fixture() {
  fetchUsage.mockReset().mockResolvedValue(usage(0))
  const settings = createCodexAccountSettings('/workspace', {
    codexAutomaticFailover: true,
    codexManagedAccounts: [
      account('a'),
      account('ubuntu', 'Ubuntu'),
      account('debian', 'Debian'),
      account('b'),
      account('c')
    ],
    activeCodexManagedAccountId: 'a',
    activeCodexManagedAccountIdsByRuntime: { host: 'a', wsl: { ubuntu: 'ubuntu' } }
  })
  const service = new CodexAutomationService(
    {
      getSettings: () => settings,
      getProfileStorageDirectory: () => '/state',
      onSettingsChanged: () => () => {}
    },
    {
      resolveCodexManagedAccountHomeForInactiveFetch: (entry) => ({
        kind: 'ready',
        homePath: entry.managedHomePath
      })
    }
  )
  return { service, settings, signal: new AbortController().signal }
}

describe('Codex account eligibility', () => {
  it('skips other runtimes and considers all remaining accounts', async () => {
    const f = fixture()
    fetchUsage.mockResolvedValueOnce(usage(100)).mockResolvedValueOnce(usage(0))
    expect((await f.service.findReplacement('/a', f.signal))?.id).toBe('c')
    expect(fetchUsage.mock.calls.map(([input]) => input.codexHomePath)).toEqual(['/b', '/c'])
  })
  it('does not cross WSL distro boundaries', async () => {
    const f = fixture()
    expect(await f.service.findReplacement('/ubuntu', f.signal)).toBeNull()
    expect(fetchUsage).not.toHaveBeenCalled()
  })
  it('stops cleanly with reset timing when every alternative is exhausted', async () => {
    const f = fixture()
    fetchUsage.mockResolvedValue(usage(100))
    expect(await f.service.findReplacement('/a', f.signal)).toBeNull()
    expect(f.service.snapshot().failure).toContain('Next reported reset:')
    expect(fetchUsage).toHaveBeenCalledTimes(2)
  })
  it('excludes previously tried accounts from an automatic continuation chain', async () => {
    const f = fixture()
    expect((await f.service.findReplacement('/a', f.signal, ['/b']))?.id).toBe('c')
    expect(fetchUsage).toHaveBeenCalledTimes(1)
  })
  it('refuses stale, missing and failed quota reads', async () => {
    const f = fixture()
    fetchUsage
      .mockResolvedValueOnce({ ...usage(0), updatedAt: 1 })
      .mockResolvedValueOnce({ ...usage(0), session: null })
    expect(await f.service.findReplacement('/a', f.signal)).toBeNull()
    fetchUsage.mockRejectedValue(new Error('network'))
    expect(await f.service.findReplacement('/a', f.signal)).toBeNull()
  })
  it('respects manual selection and disable without starting a probe', async () => {
    const f = fixture()
    f.settings.activeCodexManagedAccountIdsByRuntime = { host: 'b', wsl: {} }
    expect(await f.service.findReplacement('/a', f.signal)).toBeNull()
    f.settings.codexAutomaticFailover = false
    expect(await f.service.findReplacement('/b', f.signal)).toBeNull()
    expect(fetchUsage).not.toHaveBeenCalled()
  })
})

it('drains an in-flight warmup before acquiring a foreground home', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-warming-'))
  const settings = createCodexAccountSettings('/workspace', {
    codexResetWarming: true,
    codexManagedAccounts: [account('a')]
  })
  const quota = usage(0)
  if (quota.session) {
    quota.session.resetsAt = Date.now() - 1
  }
  fetchUsage.mockResolvedValue(quota)
  let stopped = false
  let ready = false
  warm.mockImplementation(
    async ({
      signal,
      beforeSubmit
    }: {
      signal: AbortSignal
      beforeSubmit: () => Promise<void>
    }) => {
      await beforeSubmit()
      return new Promise<boolean>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            stopped = true
            resolve(false)
          },
          { once: true }
        )
        ready = true
      })
    }
  )
  const service = new CodexAutomationService(
    {
      getSettings: () => settings,
      getProfileStorageDirectory: () => directory,
      onSettingsChanged: () => () => {}
    },
    {
      resolveCodexManagedAccountHomeForInactiveFetch: (entry) => ({
        kind: 'ready',
        homePath: entry.managedHomePath
      })
    }
  )
  try {
    await service.start()
    await vi.waitFor(() => expect(warm).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(ready).toBe(true))
    const release = await service.holdForeground('/a')
    expect(stopped).toBe(true)
    release()
  } finally {
    await service.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
