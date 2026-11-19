import { describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'
import type * as NodeChildProcess from 'node:child_process'

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  platform: () => 'darwin'
}))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
  execFile: (
    _program: string,
    _args: string[],
    _options: unknown,
    callback: (error: null, stdout: string, stderr: string) => void
  ) => {
    callback(
      null,
      JSON.stringify({
        devices: {
          iOS: [
            { name: 'iPhone 17', udid: 'A0000000-0000-0000-0000-000000000001', state: 'Booted' },
            { name: 'iPhone 17', udid: 'B0000000-0000-0000-0000-000000000002', state: 'Booted' }
          ]
        }
      }),
      ''
    )
  }
}))

import { resolveSimulatorUdid } from './simctl-simulator-devices'

describe('simulator selection', () => {
  it('refuses an ambiguous name and accepts an explicit UDID', async () => {
    await expect(resolveSimulatorUdid('iPhone 17')).rejects.toMatchObject({
      code: 'emulator_device_not_found',
      message: expect.stringContaining('select a UDID')
    })
    await expect(resolveSimulatorUdid('B0000000-0000-0000-0000-000000000002')).resolves.toBe(
      'B0000000-0000-0000-0000-000000000002'
    )
  })
})
