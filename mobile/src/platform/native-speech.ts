import { speechControlParamsSchema } from '../mobile-web-shell/bridge/bridge-speech-verbs'
import { speakReply } from '../speech/reply-speaker'

/** Device side of `native.speech.control`: the page's Read button, spoken by the shell's TTS. */
export async function serveNativeSpeechVerb(params: unknown): Promise<{ accepted: boolean }> {
  // Why: the host already validated these against this schema; parsing again types them.
  const { id, markdown } = speechControlParamsSchema.parse(params)
  speakReply(id, markdown, 'interrupt')
  return { accepted: true }
}
