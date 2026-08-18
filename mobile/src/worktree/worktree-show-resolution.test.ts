import { describe, expect, it } from 'vitest'
import { classifyWorktreeShowResponse } from './worktree-show-resolution'
import type { RpcResponse } from '../transport/types'

const meta = { runtimeId: 'runtime-1' }

function failure(code: string, message: string): RpcResponse {
  return { id: '1', ok: false, error: { code, message }, _meta: meta }
}

describe('classifyWorktreeShowResponse', () => {
  it('reads a successful show as present', () => {
    expect(
      classifyWorktreeShowResponse({ id: '1', ok: true, result: { worktree: {} }, _meta: meta })
    ).toBe('present')
  })

  it('reads the structured not-found code as missing', () => {
    expect(classifyWorktreeShowResponse(failure('selector_not_found', 'Selector not found'))).toBe(
      'missing'
    )
  })

  it('reads an older desktop runtime_error carrying the bare token as missing', () => {
    expect(classifyWorktreeShowResponse(failure('runtime_error', 'selector_not_found'))).toBe(
      'missing'
    )
  })

  it('reads a wrapped token after a message boundary as missing', () => {
    expect(
      classifyWorktreeShowResponse(
        failure('runtime_error', "Error invoking remote method 'worktree.show': selector_not_found")
      )
    ).toBe('missing')
  })

  // The bounce this feeds is destructive, so anything short of a definite answer must not trigger it.
  it('leaves transient and ambiguous failures unknown', () => {
    expect(classifyWorktreeShowResponse(failure('selector_ambiguous', 'Ambiguous'))).toBe('unknown')
    expect(classifyWorktreeShowResponse(failure('method_not_found', 'Unknown method'))).toBe(
      'unknown'
    )
    expect(classifyWorktreeShowResponse(failure('runtime_busy', 'Runtime busy'))).toBe('unknown')
  })

  it('does not read prose that merely mentions the token as missing', () => {
    expect(
      classifyWorktreeShowResponse(
        failure('runtime_error', 'Access denied after a prior selector_not_found')
      )
    ).toBe('unknown')
    expect(classifyWorktreeShowResponse(failure('runtime_error', 'stale_selector_not_found'))).toBe(
      'unknown'
    )
  })
})
