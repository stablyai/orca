import { describe, expect, it } from 'vitest'
import { mapRuntimeError } from './errors'

class LineageError extends Error {
  code = 'LINEAGE_PARENT_NOT_FOUND'
  data = {
    nextSteps: ['Run `orca worktree list`.', 'Retry with --no-parent.']
  }
}

describe('mapRuntimeError', () => {
  it('preserves structured lineage error codes and data for CLI recovery hints', () => {
    const response = mapRuntimeError(
      'req_1',
      { runtimeId: 'runtime-1' },
      new LineageError('Parent workspace was not found.')
    )

    expect(response).toEqual({
      id: 'req_1',
      ok: false,
      error: {
        code: 'LINEAGE_PARENT_NOT_FOUND',
        message: 'Parent workspace was not found.',
        data: {
          nextSteps: ['Run `orca worktree list`.', 'Retry with --no-parent.']
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
  })
})
