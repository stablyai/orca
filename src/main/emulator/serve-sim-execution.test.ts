import { describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { execServeSimCommand } from './serve-sim-execution'

const executable = { command: 'serve-sim', baseArgs: [], usesElectronAsNode: false }

function failWith(stderr: string): void {
  runProcessMock.mockResolvedValueOnce({
    code: 1,
    signal: null,
    stdout: '',
    stderr,
    timedOut: false
  })
}

describe('execServeSimCommand failure classification', () => {
  it('reports a missing serve-sim server as no active emulator', async () => {
    failWith('No serve-sim server running. Run `serve-sim` first.')
    await expect(execServeSimCommand(executable, ['tap', '0.5', '0.5'])).rejects.toMatchObject({
      code: 'emulator_no_active'
    })
  })

  it("surfaces serve-sim's own message when the camera helper is not running", async () => {
    const message =
      'camera helper not running for this device — run `serve-sim camera <bundle-id>` first.'
    failWith(message)
    await expect(
      execServeSimCommand(executable, ['camera', 'switch', 'placeholder'])
    ).rejects.toMatchObject({ code: 'emulator_error', message })
  })
})
