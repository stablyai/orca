import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliStatusResult } from '../../shared/runtime-types'
import { launchOrcaApp } from './launch'
import { openLocalOrca } from './open-local-orca'
import type { RuntimeRpcSuccess } from './types'

vi.mock('./launch', () => ({ launchOrcaApp: vi.fn() }))

function status(desktopWindowStatus: string): RuntimeRpcSuccess<CliStatusResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: openLocalOrca reads only runtime.reachable and app.desktopWindowStatus.
  return {
    ok: true,
    result: { runtime: { reachable: true }, app: { desktopWindowStatus } }
  } as unknown as RuntimeRpcSuccess<CliStatusResult>
}

describe('openLocalOrca', () => {
  beforeEach(() => {
    vi.mocked(launchOrcaApp).mockClear()
  })

  it('asks a running Orca to show its window instead of relaunching it', async () => {
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(status('openable'))
      .mockResolvedValueOnce(status('available'))
    const openWindowInBackground = vi.fn(async () => ({
      id: '1',
      ok: true as const,
      result: { requested: true },
      _meta: { runtimeId: 'runtime' }
    }))

    await openLocalOrca(readStatus, openWindowInBackground, 1_000)

    expect(openWindowInBackground).toHaveBeenCalledOnce()
    expect(launchOrcaApp).not.toHaveBeenCalled()
  })

  it('does not relaunch an older Orca whose window is already available', async () => {
    const available = status('available')

    await expect(
      openLocalOrca(
        async () => available,
        async () => {
          throw new Error('method_not_found')
        },
        1_000
      )
    ).resolves.toBe(available)
    expect(launchOrcaApp).not.toHaveBeenCalled()
  })

  it('launches Orca when an older headless runtime cannot open its own window', async () => {
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(status('openable'))
      .mockResolvedValueOnce(status('available'))

    await openLocalOrca(
      readStatus,
      async () => {
        throw new Error('method_not_found')
      },
      1_000
    )

    expect(launchOrcaApp).toHaveBeenCalledOnce()
  })
})
