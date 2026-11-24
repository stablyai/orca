import { describe, expect, it } from 'vitest'
import { claudeForeignFrameRefusesStartup } from './claude-structured-init-proof'

// Frames as Claude CLI 2.1.117 writes them for `--resume <id>`: the SessionStart hook runs while
// the transcript loads, before the CLI switches from its boot id to the resumed one.
const bootId = 'f6cdf375-e4d1-4e3e-9acf-8a6da8b2b2fe'
const resumeHookStarted = {
  type: 'system',
  subtype: 'hook_started',
  hook_id: '9ed00e70-8bae-4909-b047-a4d3b466f0a8',
  hook_name: 'SessionStart:resume',
  hook_event: 'SessionStart',
  uuid: '98dbaf9a-922b-4232-b00b-56f4cfc9d44c',
  session_id: bootId
}
const resumeHookResponse = {
  ...resumeHookStarted,
  subtype: 'hook_response',
  output: 'hi\n',
  stdout: 'hi\n',
  stderr: '',
  exit_code: 0,
  outcome: 'success'
}
const foreignInit = {
  type: 'system',
  subtype: 'init',
  session_id: bootId,
  model: 'claude-x'
}

describe('claudeForeignFrameRefusesStartup', () => {
  it('ignores a resumed start whose SessionStart hook frames carry the CLI boot id', () => {
    const resume = { resumesTranscript: true }
    expect(claudeForeignFrameRefusesStartup(resumeHookStarted, resume)).toBe(false)
    expect(claudeForeignFrameRefusesStartup(resumeHookResponse, resume)).toBe(false)
  })

  it('still refuses a foreign system/init, resumed or not', () => {
    expect(
      claudeForeignFrameRefusesStartup(foreignInit, {
        resumesTranscript: true
      })
    ).toBe(true)
    expect(
      claudeForeignFrameRefusesStartup(foreignInit, {
        resumesTranscript: false
      })
    ).toBe(true)
    const { session_id: _omitted, ...initWithoutSession } = foreignInit
    expect(
      claudeForeignFrameRefusesStartup(initWithoutSession, {
        resumesTranscript: true
      })
    ).toBe(true)
  })

  it('still refuses a foreign SessionStart frame on a new session, which names its id at boot', () => {
    const fresh = { resumesTranscript: false }
    expect(
      claudeForeignFrameRefusesStartup(
        { ...resumeHookStarted, hook_name: 'SessionStart:startup' },
        fresh
      )
    ).toBe(true)
  })

  it('ignores ordinary foreign frames', () => {
    const frame = { type: 'system', subtype: 'status', session_id: bootId }
    expect(claudeForeignFrameRefusesStartup(frame, { resumesTranscript: false })).toBe(false)
  })
})
