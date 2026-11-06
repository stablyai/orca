import { describe, expect, it, vi } from 'vitest'

import { getBranchConflictKindViaExec } from './repo-branch-conflict'

describe('portable branch-name conflicts', () => {
  function executor(refs = '') {
    return vi.fn(async (argv: string[]) => {
      if (argv[0] === 'rev-parse') {
        throw Object.assign(new Error('missing'), { code: 1, stderr: '' })
      }
      return { stdout: argv[0] === 'for-each-ref' ? refs : '' }
    })
  }

  it.each([
    Object.assign(new Error('SSH disconnected'), { code: 1, stderr: 'transport failed' }),
    Object.assign(new Error('output exceeded cap'), { code: 'ENOBUFS' })
  ])('fails closed when the bounded host listing fails: %s', async (error) => {
    const exec = executor()
    exec.mockImplementationOnce(async () => {
      throw Object.assign(new Error('missing'), { code: 1, stderr: '' })
    })
    exec.mockImplementationOnce(async () => {
      throw error
    })
    await expect(getBranchConflictKindViaExec(exec, 'Feature')).rejects.toThrow(error.message)
    expect(exec.mock.calls.some(([argv]) => argv[0] === 'remote')).toBe(false)
  })

  it('fails closed on unexpected stdout instead of treating it as an empty listing', async () => {
    const exec = executor('Welcome to the host\n')
    await expect(getBranchConflictKindViaExec(exec, 'Feature')).rejects.toThrow(
      'Cannot verify branch-name case conflicts'
    )
  })
})
