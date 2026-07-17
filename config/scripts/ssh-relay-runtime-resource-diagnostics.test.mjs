import { createRequire } from 'node:module'

import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { observeWindowsResourceSettlement } = require('./ssh-relay-runtime-resource-diagnostics.cjs')

describe('SSH relay runtime resource diagnostics', () => {
  it('observes bounded Windows resources after the cleanup drain interval', async () => {
    const delay = vi.fn(async () => {})
    const getActiveResourcesInfo = vi
      .fn()
      .mockReturnValueOnce(['PipeWrap', 'Worker', ...Array.from({ length: 300 }, () => 'Timeout')])
      .mockReturnValueOnce(['PipeWrap', 'Worker'])

    await expect(
      observeWindowsResourceSettlement({
        platform: 'win32',
        getActiveResourcesInfo,
        delay,
        observationMs: 2_000
      })
    ).resolves.toEqual({
      observationMs: 2_000,
      immediatelyAfterSmoke: {
        types: ['PipeWrap', 'Worker', ...Array.from({ length: 254 }, () => 'Timeout')],
        omitted: 46
      },
      afterObservation: { types: ['PipeWrap', 'Worker'], omitted: 0 }
    })
    expect(delay).toHaveBeenCalledOnce()
    expect(delay).toHaveBeenCalledWith(2_000)
  })

  it('does not add an observation delay to successful POSIX smoke', async () => {
    const delay = vi.fn(async () => {})
    const getActiveResourcesInfo = vi.fn(() => ['PipeWrap'])

    await expect(
      observeWindowsResourceSettlement({ platform: 'linux', getActiveResourcesInfo, delay })
    ).resolves.toBeNull()
    expect(delay).not.toHaveBeenCalled()
    expect(getActiveResourcesInfo).not.toHaveBeenCalled()
  })
})
