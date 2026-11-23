import { describe, expect, it } from 'vitest'
import { mapRuntimeError } from '../../../../responses/rpc-response'
import { refuseUnmatchedWorkerSelector } from './worker-start-selector-refusal'

const notFound = () => Promise.reject(new Error('selector_not_found'))

describe('refuseUnmatchedWorkerSelector', () => {
  it.each([
    [{ flag: '--worktree', value: 'id:gone' }, 'No workspace matches --worktree id:gone.'],
    [{ flag: '--repo', value: 'nope' }, 'No repo matches --repo nope.'],
    [{ flag: '--terminal', value: 'term_1' }, 'No terminal matches --terminal term_1.'],
    [{ flag: '--from', value: 'term_2' }, 'No terminal matches --from term_2.']
  ] as const)('names %o and says nothing started, through the RPC reply', async (label, text) => {
    const error = await refuseUnmatchedWorkerSelector(label, notFound).catch((e: unknown) => e)
    const reply = mapRuntimeError('req', { runtimeId: 'rt' }, error)
    expect(reply.error).toEqual({
      code: 'selector_not_found',
      message: `${text} Nothing was started; no effects were applied.`,
      data: { effectsApplied: false, ...label }
    })
  })

  it('passes other failures through unchanged', async () => {
    const other = new Error('selector_ambiguous')
    await expect(
      refuseUnmatchedWorkerSelector({ flag: '--repo', value: 'r' }, () => Promise.reject(other))
    ).rejects.toBe(other)
  })
})
