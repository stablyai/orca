import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { tryReadMetadata } from './metadata'
import { isStatusObservationError } from './status-observation'
import { RuntimeClientError } from './types'
import { formatCliError } from '../cli-error'

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

describe('metadata observation and compatibility', () => {
  it('missing metadata retains legacy discovery result', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('fixture'), { code: 'ENOENT' })
    })
    expect(tryReadMetadata('synthetic-folder')).toBeNull()
  })
  it.each(['EPERM', 'EACCES', 'EIO'])('%s is not evidence of absence', (code) => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('fixture'), { code })
    })
    expect(() => tryReadMetadata('synthetic-folder')).toThrow(
      'Could not verify Orca runtime status'
    )
  })
  it.each(['{broken', 'null', '42'])('malformed metadata %s cannot authorize launch', (value) => {
    vi.mocked(readFileSync).mockReturnValue(value)
    expect(() => tryReadMetadata('synthetic-folder')).toThrow(
      'Could not verify Orca runtime status'
    )
  })
  it('legacy errors without observation retain their existing handling', () => {
    const error = new RuntimeClientError('runtime_unavailable', 'legacy')
    expect(isStatusObservationError(error)).toBe(false)
    expect(formatCliError(error)).toContain("Run 'orca open'")
  })
  it('unknown optional observation versions do not authorize a startup wait', () => {
    const error = new RuntimeClientError('runtime_unavailable', 'fixture', {
      statusObservation: { version: 99, target: 'local' }
    })
    expect(isStatusObservationError(error)).toBe(false)
  })
})
