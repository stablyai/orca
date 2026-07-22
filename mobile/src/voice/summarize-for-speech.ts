// Turns a long agent reply into something a speaker can actually say.
//
// Why this exists: a coding agent's turn-end message is routinely hundreds of
// words of file paths, commit hashes and command output. Read aloud verbatim
// that is minutes of monologue and unusable as conversation, so the reply is
// folded down to two or three spoken sentences before it reaches TTS. The full
// text stays on screen in the terminal — this only decides what is SPOKEN.
//
// Operator decision 2026-07-21: summarize rather than speak verbatim.

import { meshVoiceBaseUrlFor } from './mesh-voice-endpoint'

// Same arm + ceiling reasoning as ask-herm.ts: every Config A arm emits
// chain-of-thought first, the ceiling is free when unused, and suppression is
// impossible on this stack. See ask-herm.ts for the measurements.
const SUMMARY_MODEL = 'LFM2.5-8B-A1B-Q4_0.gguf'
const MAX_SUMMARY_TOKENS = 1600

// Replies longer than this get folded; shorter ones are already speakable and
// skip the round trip entirely, which keeps quick answers instant.
export const SPEAK_VERBATIM_UNDER_CHARS = 220

// Guard the prompt: a giant reply would push the arm's context and buy nothing,
// since the summary only needs the shape of the turn.
const MAX_INPUT_CHARS = 6000

const SYSTEM_PROMPT = [
  'You compress a coding agent\'s reply into something spoken aloud to the',
  'operator who asked for it. Two or three short sentences, maximum.',
  'Plain spoken English: no markdown, no lists, no code, no file paths, no',
  'commit hashes, no URLs — they are unlistenable read out loud.',
  'Lead with the outcome: what got done, and whether anything failed or needs',
  'the operator. Say "it failed" plainly if it failed. Do not invent detail',
  'that is not in the reply, and do not add pleasantries.'
].join(' ')

/** Fold a long agent reply into a spoken-length summary. Returns the original
 *  text unchanged when it is already short enough to speak, and throws on
 *  transport failure so the caller can decide whether to fall back. */
export async function summarizeForSpeech(
  reply: string,
  options: { hostEndpoint?: string | null; signal?: AbortSignal } = {}
): Promise<string> {
  const { hostEndpoint, signal } = options
  const text = reply.trim()
  if (text.length <= SPEAK_VERBATIM_UNDER_CHARS) {
    return text
  }
  const res = await fetch(`${meshVoiceBaseUrlFor(hostEndpoint)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      max_tokens: MAX_SUMMARY_TOKENS,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text.slice(0, MAX_INPUT_CHARS) }
      ]
    })
  })
  if (!res.ok) {
    throw new Error(`Summary ${res.status}`)
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  // Why: `content` only — `reasoning_content` is chain-of-thought and must
  // never reach the speaker.
  const summary = body.choices?.[0]?.message?.content?.trim()
  if (!summary) {
    throw new Error('Summary came back empty')
  }
  return summary
}
