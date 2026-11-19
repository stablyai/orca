import { describe, expect, it } from 'vitest'
import { resumeInvocationFromOptions } from './structured-agent-cli-conversations'

const OPTIONS = {
  targetless: ['-c', '--continue'],
  markers: ['-r', '--resume']
}

describe('resumeInvocationFromOptions', () => {
  it('reads a target after a resume marker', () => {
    expect(resumeInvocationFromOptions(['codebuddy', '--resume', 'session-1'], OPTIONS)).toEqual({
      target: 'session-1'
    })
  })

  it('reads an inline target', () => {
    expect(resumeInvocationFromOptions(['codebuddy', '--resume=session-1'], OPTIONS)).toEqual({
      target: 'session-1'
    })
  })

  it('keeps a targetless continue', () => {
    expect(resumeInvocationFromOptions(['codebuddy', '--continue'], OPTIONS)).toEqual({
      target: null
    })
  })

  it('ignores option-looking prompt text after --', () => {
    expect(
      resumeInvocationFromOptions(
        ['codebuddy', '--resume', 'session-1', '--', '--continue'],
        OPTIONS
      )
    ).toEqual({ target: 'session-1' })
    expect(
      resumeInvocationFromOptions(['codebuddy', '--', '--resume', 'session-1'], OPTIONS)
    ).toBeNull()
  })
})
