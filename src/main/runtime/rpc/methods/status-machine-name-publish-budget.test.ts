import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeMachineName } from '../../../../shared/machine-name'
import { OrcaRuntimeService } from '../../orca-runtime'
import { MACHINE_NAME_PUBLISH_WAIT_MS } from '../../runtime-machine-name'
import { STATUS_METHODS } from './status'
import { partialRuntimeStore } from '../../runtime-store-partial-fixture'

// Use a fresh process before its memoized scutil lookup completes; control completion to exercise the publish deadline.
const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

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
    // Only macOS needs an async friendly-name lookup; other platforms use hostname.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    vi.useFakeTimers()
    let finishLookup: ((value: unknown) => void) | undefined
    runProcessMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve
        })
    )
    const runtime = new OrcaRuntimeService(partialRuntimeStore({ getSettings: () => ({}) }))
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
