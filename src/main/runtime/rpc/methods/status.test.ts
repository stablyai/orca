import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeMachineName } from '../../../../shared/machine-name'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeStore } from '../../runtime-store-contract'
import { STATUS_METHODS } from './status'

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

describe('status.get', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('waits for the machine-name lookup instead of publishing the bare hostname', async () => {
    // Why darwin: only macOS has a lookup to wait for; elsewhere the hostname is the detected name.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
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
    expect(runtime.readMachineName()).toBe(normalizeMachineName(os.hostname()))

    // The call is issued while the lookup is still in flight; the answer must carry what it returns.
    const pending = STATUS_METHODS[0].handler(undefined, { runtime })
    finishLookup?.({
      code: 0,
      signal: null,
      stdout: 'Friendly Name\n',
      stderr: '',
      timedOut: false
    })

    await expect(pending).resolves.toMatchObject({ machineName: 'Friendly Name' })
  })
})
