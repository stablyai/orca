import { describe, expect, it, vi } from 'vitest'
import {
  retireIdleLegacyDaemonGenerations,
  type LegacyGenerationRetirementAdapter
} from './legacy-daemon-generation-retirement'

function createAdapter(
  protocolVersion: number,
  retireIfIdle: () => Promise<boolean>
): LegacyGenerationRetirementAdapter & { retireIfIdle: ReturnType<typeof vi.fn> } {
  return {
    protocolVersion,
    retireIfIdle: vi.fn(retireIfIdle)
  }
}

describe('retireIdleLegacyDaemonGenerations', () => {
  it('removes only generations whose daemon acknowledges retirement', async () => {
    const retired = createAdapter(24, async () => true)
    const kept = createAdapter(25, async () => false)

    const result = await retireIdleLegacyDaemonGenerations([retired, kept])

    expect(retired.retireIfIdle).toHaveBeenCalledOnce()
    expect(kept.retireIfIdle).toHaveBeenCalledOnce()
    expect(result.kept).toEqual([kept])
    expect(result.retiredProtocolVersions).toEqual([24])
    expect(result.leaks).toEqual([])
  })

  it('keeps and reports a generation whose retirement is unverifiable', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unverifiable = createAdapter(26, async () => {
      throw new Error('retirement timed out')
    })

    const result = await retireIdleLegacyDaemonGenerations([unverifiable])

    expect(result.kept).toEqual([unverifiable])
    expect(result.retiredProtocolVersions).toEqual([])
    expect(result.leaks).toEqual([{ protocolVersion: 26, reason: 'retirement timed out' }])
    expect(warning).toHaveBeenCalledWith(
      '[daemon] Keeping previous-generation daemon v26; retirement timed out'
    )
    warning.mockRestore()
  })

  it('preserves adapter order across mixed outcomes', async () => {
    const first = createAdapter(24, async () => false)
    const retired = createAdapter(25, async () => true)
    const last = createAdapter(26, async () => false)

    const result = await retireIdleLegacyDaemonGenerations([first, retired, last])

    expect(result.kept).toEqual([first, last])
    expect(result.retiredProtocolVersions).toEqual([25])
  })

  it('starts every retirement probe before waiting for any one generation', async () => {
    const releases: ((retired: boolean) => void)[] = []
    const adapters = [24, 25].map((protocolVersion) =>
      createAdapter(
        protocolVersion,
        () =>
          new Promise<boolean>((resolve) => {
            releases.push(resolve)
          })
      )
    )

    const retirement = retireIdleLegacyDaemonGenerations(adapters)
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[0](false)
    releases[1](false)

    await expect(retirement).resolves.toMatchObject({ kept: adapters })
  })
})
