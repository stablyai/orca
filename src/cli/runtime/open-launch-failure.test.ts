import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { launchOrcaAppMock } = vi.hoisted(() => ({ launchOrcaAppMock: vi.fn() }))

vi.mock('./launch', () => ({ launchOrcaApp: launchOrcaAppMock }))

import { RuntimeClient } from './client'
import { RuntimeClientError } from './types'

describe('openOrca launch failure classification', () => {
  it('reports the launch exit instead of waiting out the window timeout', async () => {
    // Why: a macOS pre-JS abort kills the spawned app in ~200ms. Before this,
    // `orca open` sat for the full 15s and then blamed a missing window
    // (STA-4336), which reads as a hang and invites a retry loop.
    launchOrcaAppMock.mockReturnValue({
      failedExit: () => ({ code: null, signal: 'SIGABRT' as NodeJS.Signals })
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-open-launch-failure-'))
    const startedAt = Date.now()

    const error = await new RuntimeClient(userDataPath)
      .openOrca(15_000)
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(RuntimeClientError)
    expect((error as RuntimeClientError).code).toBe('runtime_open_failed')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('keeps waiting while the launched app is still healthy', async () => {
    launchOrcaAppMock.mockReturnValue({ failedExit: () => null })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-open-launch-healthy-'))

    const error = await new RuntimeClient(userDataPath)
      .openOrca(600)
      .catch((thrown: unknown) => thrown)

    expect((error as RuntimeClientError).code).toBe('runtime_open_timeout')
  })
})
