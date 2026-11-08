import { afterEach, expect, it, vi } from 'vitest'

import { formatCliError, reportCliError } from './format'
import { RuntimeRpcFailureError, type RuntimeRpcFailure } from './runtime/types'

afterEach(() => {
  vi.restoreAllMocks()
})

// Runtime envelopes may contain codes introduced after this client; formatting must preserve them.

it('prints an unknown code with its message and nextSteps unchanged', () => {
  const failure: RuntimeRpcFailure = {
    id: 'rpc_1',
    ok: false,
    error: {
      code: 'code_from_a_newer_host',
      message: 'Refused for a reason this CLI has never heard of.',
      data: { nextSteps: ['Do the thing the newer host suggested.'] }
    },
    _meta: { runtimeId: 'runtime_1' }
  }
  const error = new RuntimeRpcFailureError(failure)

  expect(formatCliError(error, { commandPath: ['orchestration', 'dispatch'] })).toBe(
    'Refused for a reason this CLI has never heard of.\nNext step: Do the thing the newer host suggested.'
  )
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  reportCliError(error, true, { commandPath: ['orchestration', 'dispatch'] })
  expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(failure)
})
