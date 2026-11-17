import { describe, expect, it } from 'vitest'
import { hasMissingAgentTranscript } from './agent-transcript-presence'

const missing = async (): Promise<boolean> => false
const present = async (): Promise<boolean> => true

describe('hasMissingAgentTranscript', () => {
  it('is true only for a local Claude session whose recorded transcript is not on disk', async () => {
    await expect(
      hasMissingAgentTranscript(
        'claude',
        { transcriptPath: '/h/.claude/projects/p/s.jsonl' },
        null,
        missing
      )
    ).resolves.toBe(true)
    await expect(
      hasMissingAgentTranscript(
        'claude',
        { transcriptPath: '/h/.claude/projects/p/s.jsonl' },
        null,
        present
      )
    ).resolves.toBe(false)
  })

  it('keeps the resume when nothing proves the transcript missing', async () => {
    // No recorded path, another agent, or a session on an SSH host whose files this host cannot see.
    await expect(hasMissingAgentTranscript('claude', {}, null, missing)).resolves.toBe(false)
    await expect(
      hasMissingAgentTranscript('codex', { transcriptPath: '/h/.codex/s.jsonl' }, null, missing)
    ).resolves.toBe(false)
    await expect(
      hasMissingAgentTranscript('claude', { transcriptPath: '/h/s.jsonl' }, 'ssh-1', missing)
    ).resolves.toBe(false)
  })
})
