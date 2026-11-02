import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
}))

// Verify discovery's process options; spawning and console hiding belong to runProcess.
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock
}))

const ok = (stdout: string): ProcessResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})

const timedOut: ProcessResult = {
  code: null,
  signal: 'SIGTERM',
  stdout: '',
  stderr: '',
  timedOut: true
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  }
}

describe('listSystemFontFamilies', () => {
  afterEach(() => {
    vi.resetModules()
    runProcessMock.mockReset()
  })

  it('returns no fonts when the platform font command never exits', async () => {
    await withPlatform('linux', async () => {
      runProcessMock.mockResolvedValue(timedOut)

      const { listSystemFontFamilies } = await import('./system-fonts')
      await expect(listSystemFontFamilies()).resolves.toEqual([])
    })
  })

  it('returns no fonts when the platform font command reports failure', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'nope',
      timedOut: false
    })

    await withPlatform('linux', async () => {
      const { listSystemFontFamilies } = await import('./system-fonts')
      await expect(listSystemFontFamilies()).resolves.toEqual([])
    })
  })

  const platformTimeouts: [NodeJS.Platform, number][] = [
    ['darwin', 45_000],
    ['linux', 15_000]
  ]
  it.each(platformTimeouts)(
    'asks for the %s font command timeout of %dms',
    async (platform, timeoutMs) => {
      await withPlatform(platform, async () => {
        runProcessMock.mockResolvedValue(ok('Consolas\n'))
        const { listSystemFontFamilies } = await import('./system-fonts')
        await listSystemFontFamilies()

        expect(runProcessMock.mock.calls[0]?.[0].timeoutMs).toBe(timeoutMs)
      })
    }
  )
})
