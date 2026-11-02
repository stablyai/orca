import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeMachineName } from '../../../../shared/machine-name'
import { OrcaRuntimeService } from '../../orca-runtime'
import { STATUS_METHODS } from './status'
import { StatusGetParams } from '../../../../shared/rpc-contract/status-params'
import { partialRuntimeStore } from '../../runtime-store-partial-fixture'

// Control scutil completion to test the in-flight friendly-name lookup.
const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

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
    // Only macOS waits for a friendly-name lookup; other platforms already have hostname.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    let finishLookup: ((value: unknown) => void) | undefined
    runProcessMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve
        })
    )
    const runtime = new OrcaRuntimeService(partialRuntimeStore({ getSettings: () => ({}) }))
    expect(finishLookup).toBeTypeOf('function')
    expect(runtime.readMachineName()).toBe(normalizeMachineName(os.hostname()))

    // The call is issued while the lookup is still in flight; the answer must carry what it returns.
    const pending = STATUS_METHODS[0].handler({}, { runtime })
    finishLookup?.({
      code: 0,
      signal: null,
      stdout: 'Friendly Name\n',
      stderr: '',
      timedOut: false
    })

    await expect(pending).resolves.toMatchObject({ machineName: 'Friendly Name' })
  })

  it('answers a liveness probe with the runtime id alone, and every other call in full', async () => {
    const runtime = new OrcaRuntimeService(partialRuntimeStore({ getSettings: () => ({}) }))

    await expect(STATUS_METHODS[0].handler({ probe: true }, { runtime })).resolves.toEqual({
      runtimeId: runtime.getRuntimeId()
    })
    // Callers that predate the flag send no params or other shapes; all keep the full status.
    for (const params of [undefined, {}, { probe: 'yes' }, 'status', null, []]) {
      expect(StatusGetParams.parse(params).probe).not.toBe(true)
    }
  })
})
