import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMetadata, tryReadMetadata } from './metadata'
import { getCliStatus } from './status'

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }))
afterEach(() => vi.resetAllMocks())

describe('runtime metadata access diagnostics', () => {
  it.each(['EPERM', 'EACCES'])('preserves %s in both readers and status', async (code) => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('private metadata path'), { code })
    })
    const expected = {
      code: 'runtime_permission_denied',
      data: {
        reason: 'permission_denied',
        operation: 'read_metadata',
        systemCode: code,
        processState: 'unverifiable'
      }
    }
    for (const read of [readMetadata, tryReadMetadata]) {
      expect(() => read('/test')).toThrowError(expect.objectContaining(expected))
    }
    await expect(getCliStatus('/test')).rejects.toMatchObject(expected)
  })

  it('retains not running for absent metadata', async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    })
    expect(tryReadMetadata('/test')).toBeNull()
    await expect(getCliStatus('/test')).resolves.toMatchObject({
      result: { runtime: { state: 'not_running' } }
    })
  })

  it('retains malformed metadata handling', () => {
    vi.mocked(readFileSync).mockReturnValue('invalid JSON')
    expect(tryReadMetadata('/test')).toBeNull()
    expect(() => readMetadata('/test')).toThrow('Could not read Orca runtime metadata')
  })
})
