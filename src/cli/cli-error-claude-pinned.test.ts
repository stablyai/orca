import { expect, it } from 'vitest'
import { formatCliError } from './cli-error'
import { RuntimeRpcFailureError } from './runtime-client'

it('prints a pinned Claude refusal without the renderer marker', () => {
  const error = new RuntimeRpcFailureError({
    id: 'request-1',
    ok: false,
    error: {
      code: 'runtime_error',
      message: 'That Claude account no longer exists. [claude_pinned:account-missing]'
    },
    _meta: { runtimeId: 'runtime-1' }
  })
  const output = formatCliError(error)
  expect(output).toContain('That Claude account no longer exists.')
  expect(output).not.toContain('claude_pinned')
})
