import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execBridge, mapBridgeError } from './desktop-script-provider-bridge'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('../../cli/command-paths/cli-install-path-format', () => ({
  isExecutableFile: async () => true
}))

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

describe('execBridge on Linux', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('falls back to the system python3 when the PATH one cannot load PyGObject', async () => {
    execFileMock.mockImplementation(
      (command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        queueMicrotask(() => {
          if (command === 'python3') {
            callback(
              Object.assign(new Error('Command failed'), { killed: false }),
              '',
              "PyGObject unavailable in interpreter: /home/u/.pyenv/versions/3.12.4/bin/python3\nNo module named 'gi'\n"
            )
            return
          }
          callback(null, '{"ok":true}', '')
        })
        return { once: vi.fn(), kill: vi.fn() }
      }
    )

    await expect(execBridge('linux', '/app/runtime.py', '/tmp/op.json')).resolves.toEqual({
      stdout: '{"ok":true}',
      stderr: ''
    })
    await execBridge('linux', '/app/runtime.py', '/tmp/op.json')

    expect(execFileMock.mock.calls.map(([command]) => command)).toEqual([
      'python3',
      '/usr/bin/python3',
      '/usr/bin/python3'
    ])
  })
})

describe('mapBridgeError', () => {
  it('keeps the code a provider refusal names', () => {
    expect(
      mapBridgeError(
        'element_not_enabled: element 4 is disabled, so no input was sent; run get-app-state and use a fresh element index'
      ).code
    ).toBe('element_not_enabled')
    expect(
      mapBridgeError(
        "unsupported_capability: Linux computer use can't reach the AT-SPI accessibility bus, so nothing was sent."
      ).code
    ).toBe('unsupported_capability')
  })
})
