import { describe, expect, it } from 'vitest'
import { proveClaudeTuiResume, readClaudeTuiSessionStartEvidence } from './claude-tui-resume-proof'

const SESSION = '91deba8d-a398-4b69-a05d-35041536fe8e'
const TRANSCRIPT = '/accounts/claude/projects/workspace/transcript.jsonl'

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    launchToken: 'spawn-one',
    payload: JSON.stringify({
      hook_event_name: 'SessionStart',
      source: 'resume',
      session_id: SESSION,
      transcript_path: TRANSCRIPT,
      ...overrides
    })
  }
}

describe('Claude TUI resume proof', () => {
  it('reads SessionStart identity from the hook envelope', () => {
    expect(readClaudeTuiSessionStartEvidence(envelope())).toEqual({
      hookEventName: 'SessionStart',
      source: 'resume',
      sessionId: SESSION,
      transcriptPath: TRANSCRIPT,
      launchToken: 'spawn-one'
    })
  })

  it('proves the exact launched session and transcript without terminal output', async () => {
    await expect(
      proveClaudeTuiResume({
        expectedSessionId: SESSION,
        expectedTranscriptPath: TRANSCRIPT,
        expectedLaunchToken: 'spawn-one',
        waitForSessionStart: async () => envelope()
      })
    ).resolves.toMatchObject({ sessionId: SESSION, transcriptPath: TRANSCRIPT })
  })

  it.each([
    ['source', { source: 'startup' }, /resume SessionStart/],
    ['session', { session_id: 'other-session' }, /different Claude session/],
    ['transcript', { transcript_path: '/other/transcript.jsonl' }, /different Claude transcript/]
  ])('rejects a mismatched %s', async (_name, overrides, expected) => {
    await expect(
      proveClaudeTuiResume({
        expectedSessionId: SESSION,
        expectedTranscriptPath: TRANSCRIPT,
        expectedLaunchToken: 'spawn-one',
        waitForSessionStart: async () => envelope(overrides)
      })
    ).rejects.toThrow(expected)
  })

  it('rejects a SessionStart from another launched process', async () => {
    await expect(
      proveClaudeTuiResume({
        expectedSessionId: SESSION,
        expectedTranscriptPath: TRANSCRIPT,
        expectedLaunchToken: 'spawn-two',
        waitForSessionStart: async () => envelope()
      })
    ).rejects.toThrow(/different launched process/)
  })

  it('compares Windows paths using host path semantics', async () => {
    await expect(
      proveClaudeTuiResume({
        expectedSessionId: SESSION,
        expectedTranscriptPath: 'C:\\Users\\Dev\\session.jsonl',
        expectedLaunchToken: 'spawn-one',
        platform: 'win32',
        waitForSessionStart: async () =>
          envelope({ transcript_path: 'c:\\users\\dev\\session.jsonl' })
      })
    ).resolves.toMatchObject({ sessionId: SESSION })
  })
})
