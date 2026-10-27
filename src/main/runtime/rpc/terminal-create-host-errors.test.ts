import { describe, expect, it } from 'vitest'
import { mapRuntimeError } from './errors'

describe('terminal create host refusals over RPC', () => {
  it.each([
    'project_not_set_up_on_host',
    'host_kind_not_supported_yet',
    'invalid_runtime_response'
  ])('preserves %s and the setup recovery data', (code) => {
    const data = { worktreeId: 'repo::/project', executionHostId: 'ssh:target' }
    const error = Object.assign(new Error('The requested host cannot create this terminal'), {
      code,
      data
    })

    expect(mapRuntimeError('request', { runtimeId: 'runtime' }, error)).toMatchObject({
      ok: false,
      error: { code, message: error.message, data }
    })
  })

  it('does not let an unlisted structured code cross the boundary', () => {
    const error = Object.assign(new Error('Unknown host refusal'), {
      code: 'unlisted_terminal_host_refusal',
      data: { executionHostId: 'ssh:target' }
    })

    expect(mapRuntimeError('request', { runtimeId: 'runtime' }, error)).toMatchObject({
      ok: false,
      error: { code: 'runtime_error', message: error.message }
    })
    expect(mapRuntimeError('request', { runtimeId: 'runtime' }, error).error.data).toBeUndefined()
  })
})
