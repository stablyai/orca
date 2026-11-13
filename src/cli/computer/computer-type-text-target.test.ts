import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime/client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }
  return { RuntimeClient }
})

import { main } from '../index'
import { okFixture, queueFixtures } from '../runtime/fixtures/runtime-rpc-fixtures'

describe('orca computer type-text element target', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  it('refuses element-targeted type-text on a runtime that does not report it', async () => {
    queueFixtures(
      callMock,
      okFixture('req_capabilities', {
        platform: 'win32',
        provider: 'orca-computer-use-windows',
        providerVersion: '1.0.0',
        protocolVersion: 1,
        supports: { actions: { typeText: true, setValue: true } }
      })
    )

    await main(
      [
        'computer',
        'type-text',
        '--session',
        'manual',
        '--app',
        'Notepad',
        '--element-index',
        '3',
        '--text',
        'hello',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('computer.capabilities', {})
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output.error).toMatchObject({ code: 'unsupported_capability' })
    expect(process.exitCode).toBe(1)
  })
})
