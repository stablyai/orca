import { describe, expect, it, vi } from 'vitest'
import { prepareComputerCliJsonResult } from './computer-format'
import { printResult } from './format'

describe('prepareComputerCliJsonResult', () => {
  it.each([
    'Physical size: 1440x3200\n',
    '33',
    'screenshotStatus',
    '',
    42,
    -1,
    0,
    true,
    false,
    null
  ])('preserves successful primitive JSON output for %j', (result) => {
    const response = {
      id: 'req-primitive',
      ok: true as const,
      result,
      _meta: { runtimeId: 'runtime-1' }
    }
    const formatter = vi.fn(() => 'unused')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      expect(prepareComputerCliJsonResult(response)).toBe(response)
      printResult(response, true, formatter)
      expect(logSpy).toHaveBeenCalledOnce()
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(response, null, 2))
      expect(formatter).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
    }
  })

  it.each([
    { result: {} },
    { result: [] },
    { result: { screenshotStatus: {} } },
    { result: { screenshot: { data: 'cG5n', format: 'png' } } }
  ])('preserves object results without a computer screenshot: %j', ({ result }) => {
    const response = {
      id: 'req-object',
      ok: true as const,
      result,
      _meta: { runtimeId: 'runtime-1' }
    }

    expect(prepareComputerCliJsonResult(response)).toBe(response)
  })
})
