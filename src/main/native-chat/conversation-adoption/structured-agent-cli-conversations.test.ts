import { describe, expect, it } from 'vitest'
import { resumeInvocationFromOptions } from './structured-agent-cli-conversations'

const OPTIONS = { targetless: ['-c', '--continue'], markers: ['--resume'] }

describe('resumeInvocationFromOptions', () => {
  it('reads the marker target', () => {
    expect(resumeInvocationFromOptions(['vibe', '--resume', 'abc'], OPTIONS)).toEqual({
      target: 'abc'
    })
    expect(resumeInvocationFromOptions(['vibe', '--resume=abc'], OPTIONS)).toEqual({
      target: 'abc'
    })
  })

  it('treats a bare marker and targetless flags as targetless by default', () => {
    expect(resumeInvocationFromOptions(['vibe', '--resume'], OPTIONS)).toEqual({ target: null })
    expect(resumeInvocationFromOptions(['vibe', '-c'], OPTIONS)).toEqual({ target: null })
    expect(resumeInvocationFromOptions(['vibe', '--resume', 'abc', '-c'], OPTIONS)).toEqual({
      target: null
    })
  })

  it('lets the marker target win with markerTargetWins', () => {
    const options = { ...OPTIONS, markerTargetWins: true }
    expect(resumeInvocationFromOptions(['vibe', '--resume', 'abc', '-c'], options)).toEqual({
      target: 'abc'
    })
    expect(resumeInvocationFromOptions(['vibe', '-c', '--resume=abc'], options)).toEqual({
      target: 'abc'
    })
    expect(resumeInvocationFromOptions(['vibe', '-c'], options)).toEqual({ target: null })
    expect(resumeInvocationFromOptions(['vibe', '--resume'], options)).toEqual({ target: null })
  })

  it('returns null for a plain start', () => {
    expect(resumeInvocationFromOptions(['vibe', 'hello'], OPTIONS)).toBeNull()
  })
})
