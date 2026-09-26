import { expect, it } from 'vitest'
import { formatCliError } from './cli-error'
import { RuntimeRpcFailureError } from './runtime-client'

it('prints a pinned Claude refusal without the renderer marker', () => {
  const error = new RuntimeRpcFailureError({
    id: 'request-1',
    ok: false,
    error: {
      code: 'runtime_error',
      message:
        'Claude account a@b.c is still in use. [claude_pinned:host-sessions email=a%40b.c terminals=1]'
    },
    _meta: { runtimeId: 'runtime-1' }
  })
  const output = formatCliError(error)
  expect(output).toContain('Claude account a@b.c is still in use.')
  expect(output).not.toContain('claude_pinned')
})
