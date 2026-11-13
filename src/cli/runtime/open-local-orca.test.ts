import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliStatusResult } from '../../shared/runtime-types'
import { launchOrcaApp } from './launch'
import { openLocalOrca } from './open-local-orca'
import type { RuntimeRpcSuccess } from './types'

vi.mock('./launch', () => ({ launchOrcaApp: vi.fn() }))

function status(desktopWindowStatus: string): RuntimeRpcSuccess<CliStatusResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: openLocalOrca reads only app.desktopWindowStatus.
  return {
    ok: true,
    result: { app: { desktopWindowStatus } }
  } as unknown as RuntimeRpcSuccess<CliStatusResult>
}

describe('openLocalOrca', () => {
  beforeEach(() => {
    vi.mocked(launchOrcaApp).mockClear()
  })

  it('does not relaunch an Orca whose window is already available', async () => {
    const available = status('available')

    await expect(openLocalOrca(async () => available, 1_000)).resolves.toBe(available)
    expect(launchOrcaApp).not.toHaveBeenCalled()
  })

  it('launches Orca when only a headless runtime is running', async () => {
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(status('openable'))
      .mockResolvedValueOnce(status('available'))

    await openLocalOrca(readStatus, 1_000)
    expect(launchOrcaApp).toHaveBeenCalledOnce()
  })
})
