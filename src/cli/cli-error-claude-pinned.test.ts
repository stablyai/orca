import { afterEach, expect, it, vi } from 'vitest'
import { formatCliError, reportCliError } from './output/cli-error'
import { RuntimeRpcFailureError } from './runtime/types'

function pinnedRefusal(): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'request-1',
    ok: false,
    error: {
      code: 'runtime_error',
      message: 'That Claude account no longer exists. [claude_pinned:account-missing]'
    },
    _meta: { runtimeId: 'runtime-1' }
  })
}

afterEach(() => vi.restoreAllMocks())

it('prints a pinned Claude refusal without the renderer marker', () => {
  const output = formatCliError(pinnedRefusal())
  expect(output).toContain('That Claude account no longer exists.')
  expect(output).not.toContain('claude_pinned')
})

it('keeps the marker out of --json output and the concise error line', () => {
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
  reportCliError(pinnedRefusal(), true)
  reportCliError(pinnedRefusal(), true, { conciseOrchestration: true })
  const printed = [...stdout.mock.calls, ...stderr.mock.calls].flat().join('\n')
  expect(printed).toContain('That Claude account no longer exists.')
  expect(printed).not.toContain('claude_pinned')
})
