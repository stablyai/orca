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

const actionResult = {
  snapshot: {
    app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 42 },
    window: { id: 7, index: 0, title: 'Untitled', width: 800, height: 600 },
    elementCount: 1,
    treeText: '0 button OK'
  },
  screenshot: null,
  screenshotStatus: { state: 'skipped' }
}

async function click(...extra: string[]): Promise<Record<string, unknown>> {
  queueFixtures(callMock, okFixture('req_click', actionResult))
  await main(
    [
      'computer',
      'click',
      '--session',
      'manual',
      '--app',
      'TextEdit',
      '--element-index',
      '0',
      ...extra,
      '--json'
    ],
    '/tmp/repo/src'
  )
  expect(callMock).toHaveBeenCalledTimes(1)
  expect(callMock.mock.calls[0][0]).toBe('computer.click')
  return callMock.mock.calls[0][1]
}

describe('orca computer action screenshots', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  it('asks the runtime to skip the screenshot by default', async () => {
    const params = await click()
    expect(params.noScreenshot).toBe(true)
  })

  it('captures a screenshot when --screenshot is passed', async () => {
    const params = await click('--screenshot')
    expect(params.noScreenshot).toBeUndefined()
  })

  it('treats a screenshot size flag as asking for a screenshot', async () => {
    const params = await click('--screenshot-scale', '1')
    expect(params).toMatchObject({ screenshotScale: 1 })
    expect(params.noScreenshot).toBeUndefined()
  })

  it('refuses --screenshot together with --no-screenshot', async () => {
    await main(
      [
        'computer',
        'click',
        '--session',
        'manual',
        '--app',
        'TextEdit',
        '--element-index',
        '0',
        '--screenshot',
        '--no-screenshot',
        '--json'
      ],
      '/tmp/repo/src'
    )
    expect(callMock).not.toHaveBeenCalled()
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output.error).toMatchObject({ code: 'invalid_argument' })
    expect(process.exitCode).toBe(1)
  })
})
