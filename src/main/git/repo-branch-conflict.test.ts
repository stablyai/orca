import { describe, expect, it, vi } from 'vitest'

import {
  getBranchConflictKindStrictViaExec,
  getBranchConflictKindViaExec
} from './repo-branch-conflict'

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

  describe('strict probe for exact-name creates', () => {
    const noMatch = () => Object.assign(new Error('missing'), { code: 1, stderr: '' })
    const transport = () => Object.assign(new Error('SSH disconnected'), { code: 255 })
    // origin is configured; each case breaks one probe boundary.
    function strictExecutor(broken: 'local' | 'remote-names' | 'remote-ref', remoteHit = false) {
      return vi.fn(async (argv: string[]) => {
        if (argv[0] === 'rev-parse') {
          throw broken === 'local' ? transport() : noMatch()
        }
        if (argv[0] === 'remote') {
          if (broken === 'remote-names') {
            throw transport()
          }
          return { stdout: 'origin\n' }
        }
        if (argv[0] === 'show-ref') {
          if (remoteHit) {
            return { stdout: '' }
          }
          throw broken === 'remote-ref' ? transport() : noMatch()
        }
        return { stdout: '' }
      })
    }

    it.each(['local', 'remote-names', 'remote-ref'] as const)(
      'reports unknown when the %s probe cannot decide',
      async (broken) => {
        await expect(
          getBranchConflictKindStrictViaExec(strictExecutor(broken), 'feature')
        ).resolves.toBe('unknown')
      }
    )

    it('keeps the lenient probe answering free where the strict one is unknown', async () => {
      await expect(getBranchConflictKindViaExec(strictExecutor('local'), 'feature')).resolves.toBe(
        null
      )
    })

    it('lets a known remote conflict win over an undecided local probe', async () => {
      await expect(
        getBranchConflictKindStrictViaExec(strictExecutor('local', true), 'feature')
      ).resolves.toBe('remote')
    })

    it('reports unknown instead of throwing when the case-fold listing fails', async () => {
      const exec = strictExecutor('remote-ref')
      exec.mockImplementation(async (argv: string[]) => {
        if (argv[0] === 'rev-parse') {
          throw noMatch()
        }
        if (argv[0] === 'for-each-ref') {
          throw transport()
        }
        return { stdout: '' }
      })
      await expect(getBranchConflictKindStrictViaExec(exec, 'feature')).resolves.toBe('unknown')
    })
  })
})
