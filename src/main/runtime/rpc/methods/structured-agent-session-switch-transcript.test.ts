import { afterEach, expect, it, vi } from 'vitest'
import * as cliTranscript from '../../../ai-vault/structured-chat-cli-fork'
import { prepareSwitchCliTranscript } from './structured-agent-session-switch-transcript'

const runtime = { prepareAiVaultSessionResume: vi.fn() }

afterEach(() => vi.restoreAllMocks())

function failPreparation(error: Error) {
  vi.spyOn(cliTranscript, 'resolveStructuredChatCliSource').mockRejectedValue(error)
}

it.each([
  [false, 'transcriptNotFound', 'transcriptNotFound'],
  [false, 'transcriptUnreadable', 'transcriptUnreadable'],
  // A chat that already shows saved turns: a missing file is history Orca can't read.
  [true, 'transcriptNotFound', 'transcriptUnreadable']
] as const)('types a transcript failure (saved=%s, %s → %s)', async (saved, reason, expected) => {
  failPreparation(new cliTranscript.StructuredChatTranscriptError('no file', reason))
  await expect(
    prepareSwitchCliTranscript(runtime, 'chat', 'workspace', saved)
  ).rejects.toMatchObject({
    refusal: { code: 'agent_session_identity_required', details: { reason: expected } }
  })
})

it('keeps an unrelated precondition’s own error, such as a rewind waiting for its next message', async () => {
  const rewind = new Error('Send a message after rewinding this chat, then open it in a terminal.')
  failPreparation(rewind)
  await expect(prepareSwitchCliTranscript(runtime, 'chat', 'workspace', true)).rejects.toBe(rewind)
})
