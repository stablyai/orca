import { describe, expect, it, vi } from 'vitest'
import { printResult } from './format'

describe('printResult with a primitive result', () => {
  it('prints it under --json instead of throwing', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    for (const result of ['6C707041-05AC MacBook Pro Camera', 42, null]) {
      logSpy.mockClear()
      expect(() =>
        printResult(
          { id: 'req-primitive', ok: true, result, _meta: { runtimeId: 'runtime-1' } },
          true,
          () => 'unused'
        )
      ).not.toThrow()
      expect(JSON.parse(logSpy.mock.calls[0][0] as string).result).toStrictEqual(result)
    }

    logSpy.mockRestore()
  })
})
