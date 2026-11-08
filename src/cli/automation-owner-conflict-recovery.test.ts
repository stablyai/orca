import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatCliError } from './format'
import { RuntimeRpcFailureError } from './runtime-client'

function conflict(code: string, message: string): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'request-1',
    ok: false,
    error: { code, message: `${message}: ${code}` },
    _meta: { runtimeId: 'runtime-1' }
  })
}

afterEach(() => vi.restoreAllMocks())

describe('automation owner conflicts read as CLI outcomes', () => {
  it('leaves unrelated failures untouched', () => {
    const output = formatCliError(conflict('runtime_error', 'Something else'))

    expect(output).toBe('Something else: runtime_error')
  })
})
