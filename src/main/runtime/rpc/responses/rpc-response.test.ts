import { describe, expect, it } from 'vitest'
import { mapRuntimeError } from './rpc-response'
import { AGENT_LAUNCH_DISABLED_CODE } from '../../../../shared/agent-launch-disabled'

describe('disabled agent launch', () => {
  it('keeps its refusal code instead of collapsing to runtime_error', () => {
    const error = Object.assign(new Error('Claude is disabled by settings.'), {
      code: AGENT_LAUNCH_DISABLED_CODE
    })
    expect(mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)).toMatchObject({
      ok: false,
      error: { code: AGENT_LAUNCH_DISABLED_CODE, message: 'Claude is disabled by settings.' }
    })
  })
})
