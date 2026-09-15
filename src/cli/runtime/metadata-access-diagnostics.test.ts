import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMetadata, tryReadMetadata } from './metadata'
import { getCliStatus } from './status'

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }))
afterEach(() => vi.resetAllMocks())

describe('runtime metadata access diagnostics', () => {
  it.each(['EPERM', 'EACCES'])(
    'preserves %s for both metadata readers and status',
    async (code) => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('denied metadata path'), { code })
      })
      const expected = {
        code: 'runtime_unavailable',
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
    }
  )

  it('still reports not running for absent metadata', async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('metadata absent'), { code: 'ENOENT' })
    })
    expect(tryReadMetadata('/test')).toBeNull()
    expect(() => readMetadata('/test')).toThrow('Start the Orca app first')
    await expect(getCliStatus('/test')).resolves.toMatchObject({
      result: { runtime: { state: 'not_running' } }
    })
  })

  it('preserves malformed metadata recovery', () => {
    vi.mocked(readFileSync).mockReturnValue('invalid JSON')
    expect(tryReadMetadata('/test')).toBeNull()
    expect(() => readMetadata('/test')).toThrow('Could not read Orca runtime metadata')
  })
})
