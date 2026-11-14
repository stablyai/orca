import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexAccountSelectionTarget } from '../../../../shared/codex-selection-lane'
import type { CodexRateLimitHomeResolution } from '../../../codex-accounts/runtime-home/runtime-home-service-types'

vi.mock('../../../wsl/discovery/wsl-default-distro', () => ({
  resolveWslDefaultDistro: vi.fn(async () => null)
}))

const { resolveCodexRateLimitHomeUnlessStopped } = await import('./codex-rate-limit-wsl-home-gate')

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const homeIn = (distro: string): string => `\\\\wsl.localhost\\${distro}\\home\\me\\.codex`

function harness(running: string[], home: (target?: CodexAccountSelectionTarget) => string | null) {
  const prepareForRateLimitFetch = vi.fn(
    (
      target?: CodexAccountSelectionTarget,
      pinnedWslDistro?: string
    ): CodexRateLimitHomeResolution => ({
      kind: 'ready',
      codexHomePath: home(pinnedWslDistro ? { runtime: 'wsl', wslDistro: pinnedWslDistro } : target)
    })
  )
  const deps = {
    // The `wsl -l` default runs; the distro the account targets may not.
    defaultDistro: vi.fn(async (): Promise<string | null> => 'Ubuntu'),
    isRunning: vi.fn(async (distro: string) => running.includes(distro))
  }
  return { source: { prepareForRateLimitFetch }, deps, prepareForRateLimitFetch }
}

describe('Codex quota poll home for a WSL account (E9)', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('skips a home that lives in a distro other than the one it read as running', async () => {
    // The gated default runs, but the account's home is in a stopped distro.
    const h = harness(['Ubuntu'], () => homeIn('orca-w'))

    const resolution = await resolveCodexRateLimitHomeUnlessStopped(
      h.source,
      { runtime: 'wsl' },
      h.deps
    )

    expect(resolution).toEqual({ kind: 'skip' })
  })

  it('skips when no distro can be named', async () => {
    const h = harness([], () => null)
    h.deps.defaultDistro.mockResolvedValue(null)

    await expect(
      resolveCodexRateLimitHomeUnlessStopped(h.source, { runtime: 'wsl' }, h.deps)
    ).resolves.toEqual({ kind: 'skip' })
    expect(h.prepareForRateLimitFetch).not.toHaveBeenCalled()
  })
})
