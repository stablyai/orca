import { speechControlParamsSchema } from '../mobile-web-shell/bridge/bridge-speech-verbs'
import { speakReply, stopSpeaking } from '../speech/reply-speaker'

/** Device side of `native.speech.control`: the page's Read button, spoken by the shell's TTS. */
export async function serveNativeSpeechVerb(params: unknown): Promise<{ accepted: boolean }> {
  // Why: the host already validated these against this schema; parsing again types them.
  const call = speechControlParamsSchema.parse(params)
  if (call.action === 'stop') {
    stopSpeaking('page asked to stop')
  } else {
    speakReply(call.id, call.markdown, 'interrupt')
  }
  return { accepted: true }
}
