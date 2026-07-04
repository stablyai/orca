import { describe, expect, it } from 'vitest'
import {
  PR_CHECK_LOG_TAIL_BYTES,
  PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR,
  sliceCheckLogTail
} from './check-job-log-tail-slice'

describe('sliceCheckLogTail', () => {
  it('keeps the recent tail when no earlier error markers are present', () => {
    const logLines = Array.from({ length: 210 }, (_, index) => `line ${index}`)
    const sliced = sliceCheckLogTail(logLines.join('\n'))

    expect(sliced).toContain('line 209')
    expect(sliced).not.toContain('line 0')
    expect(Buffer.from(sliced, 'utf8').byteLength).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
  })

  it('pulls earlier error lines into the excerpt when the recent tail is noisy', () => {
    const noisyPrefix = Array.from({ length: 120 }, (_, index) => `Setting up package-${index}`)
    const failure = '##[error]Process completed with exit code 236.'
    const noisySuffix = Array.from({ length: 100 }, (_, index) => `Running trigger ${index}`)
    const sliced = sliceCheckLogTail([...noisyPrefix, failure, ...noisySuffix].join('\n'))

    expect(sliced).toContain(failure)
    expect(sliced).toContain(PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)
    expect(sliced).toContain('Running trigger 39')
    expect(sliced).not.toContain('Setting up package-0')
    expect(Buffer.from(sliced, 'utf8').byteLength).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
  })

  it('still applies the byte cap after combining earlier errors with the recent tail', () => {
    const logLines = Array.from({ length: 220 }, (_, index) => `line ${index} ${'x'.repeat(120)}`)
    const sliced = sliceCheckLogTail(logLines.join('\n'))

    expect(sliced).toContain('line 219')
    expect(Buffer.from(sliced, 'utf8').byteLength).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
  })

  it('keeps earlier error context when the recent tail is larger than the byte cap', () => {
    const noisyPrefix = Array.from({ length: 120 }, (_, index) => `Installing package ${index}`)
    const failure = 'AssertionError: expected visible failure'
    const hugeRecentTail = Array.from(
      { length: 100 },
      (_, index) => `recent line ${index} ${'x'.repeat(300)}`
    )
    const sliced = sliceCheckLogTail([...noisyPrefix, failure, ...hugeRecentTail].join('\n'))

    expect(sliced).toContain(failure)
    expect(sliced).toContain(PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR)
    expect(sliced).toContain('recent line 99')
    expect(Buffer.from(sliced, 'utf8').byteLength).toBeLessThanOrEqual(PR_CHECK_LOG_TAIL_BYTES)
  })
})
