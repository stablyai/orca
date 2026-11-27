import { describe, expect, it } from 'vitest'
import { VIBE_SESSION_HISTORY } from './vibe-session-history'

describe('VIBE_SESSION_HISTORY.parseResumeArgs', () => {
  it('reads the session id after --resume', () => {
    expect(VIBE_SESSION_HISTORY.parseResumeArgs(['vibe', '--resume', 'abc123'])).toEqual({
      target: 'abc123'
    })
  })

  it('reads an inline --resume=<id>', () => {
    expect(VIBE_SESSION_HISTORY.parseResumeArgs(['vibe', '--resume=abc123'])).toEqual({
      target: 'abc123'
    })
  })

  it('treats a bare --resume (picker) as targetless', () => {
    expect(VIBE_SESSION_HISTORY.parseResumeArgs(['vibe', '--resume'])).toEqual({ target: null })
  })

  it('treats --continue as targetless', () => {
    expect(VIBE_SESSION_HISTORY.parseResumeArgs(['vibe', '-c'])).toEqual({ target: null })
    expect(VIBE_SESSION_HISTORY.parseResumeArgs(['vibe', '--continue'])).toEqual({ target: null })
  })

  it('returns null for a plain start', () => {
    expect(VIBE_SESSION_HISTORY.parseResumeArgs(['vibe', 'hello'])).toBeNull()
  })
})
