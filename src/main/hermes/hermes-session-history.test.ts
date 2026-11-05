import { describe, expect, it } from 'vitest'
import { HERMES_SESSION_HISTORY } from './hermes-session-history'

const TIMESTAMP_ID = '20261031_153045_ab12cd'
const UUID_ID = '11111111-1111-4111-8111-111111111111'

describe('Hermes resume targets', () => {
  it('ignores commands that do not resume', () => {
    expect(HERMES_SESSION_HISTORY.parseResumeArgs(['chat', 'hello'])).toBeNull()
  })

  it('keeps a timestamp or ACP session id', () => {
    expect(HERMES_SESSION_HISTORY.parseResumeArgs(['--resume', TIMESTAMP_ID])).toEqual({
      target: TIMESTAMP_ID
    })
    expect(HERMES_SESSION_HISTORY.parseResumeArgs(['-r', UUID_ID])).toEqual({ target: UUID_ID })
    expect(HERMES_SESSION_HISTORY.parseResumeArgs([`--resume=${UUID_ID}`])).toEqual({
      target: UUID_ID
    })
  })

  it('treats titles, latest, and targetless continue as any owned session', () => {
    expect(HERMES_SESSION_HISTORY.parseResumeArgs(['--resume', 'latest'])).toEqual({
      target: null
    })
    expect(HERMES_SESSION_HISTORY.parseResumeArgs(['--resume', 'my-chat'])).toEqual({
      target: null
    })
    expect(HERMES_SESSION_HISTORY.parseResumeArgs(['--continue'])).toEqual({ target: null })
    expect(HERMES_SESSION_HISTORY.parseResumeArgs(['-c', 'named'])).toEqual({ target: null })
    expect(HERMES_SESSION_HISTORY.parseResumeArgs(['--resume'])).toEqual({ target: null })
    expect(HERMES_SESSION_HISTORY.parseResumeArgs(['--resume', 'cron_nightly'])).toEqual({
      target: null
    })
  })
})
