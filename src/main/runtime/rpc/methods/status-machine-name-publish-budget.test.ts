import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeMachineName } from '../../../../shared/machine-name'
import { OrcaRuntimeService } from '../../orca-runtime'
import { MACHINE_NAME_PUBLISH_WAIT_MS } from '../../runtime-machine-name'
import type { RuntimeStore } from '../../runtime-store-contract'
import { STATUS_METHODS } from './status'

// Why its own file: the lookup memo is process-wide, and `status.test.ts` already lands it; this
// case needs a process whose first lookup is still running when the publish budget runs out.
// Why mocked: the friendly-name lookup is the one path that spawns `scutil`; the test decides when it lands.
const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('status.get publish budget', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.useRealTimers()
  })

  it('stops waiting at the budget and carries the friendly name on the next read', async () => {
    // Why darwin: only macOS has a lookup to wait for; elsewhere the hostname is the detected name.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    vi.useFakeTimers()
    let finishLookup: ((value: unknown) => void) | undefined
    runProcessMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve
        })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only `getSettings` off the store during construction and status.
    const runtime = new OrcaRuntimeService({ getSettings: () => ({}) } as RuntimeStore)
    expect(finishLookup).toBeTypeOf('function')
    const hostname = normalizeMachineName(os.hostname())

    // The lookup outlives the budget: the answer is the hostname, not a probe that reads as "down".
    const pending = STATUS_METHODS[0].handler(undefined, { runtime })
    await vi.advanceTimersByTimeAsync(MACHINE_NAME_PUBLISH_WAIT_MS)
    await expect(pending).resolves.toMatchObject({ machineName: hostname })

    // The lookup was never abandoned; once it lands, the next read publishes what it found.
    finishLookup?.({
      code: 0,
      signal: null,
      stdout: 'Friendly Name\n',
      stderr: '',
      timedOut: false
    })
    await expect(STATUS_METHODS[0].handler(undefined, { runtime })).resolves.toMatchObject({
      machineName: 'Friendly Name'
    })
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })
})
