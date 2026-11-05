import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { providerFailureMessage } from './text-subscription-request'

export function parseCodexSubscriptionOutput(
  stdout: string,
  code: number | null,
  exhausted: boolean
) {
  let answer: string | undefined
  let failure: string | undefined
  let completed = false
  let unsafeProgress = false
  try {
    for (const line of stdout.split(/\r?\n/).filter((line) => line.trim())) {
      assertJsonTextStructureWithinLimits(line, { structuralTokens: 65536, nestingDepth: 32 })
      const frame = JSON.parse(line)
      if (typeof frame.type === 'string' && frame.type.startsWith('item.')) {
        const item = frame.item
        if (
          !['item.started', 'item.updated', 'item.completed'].includes(frame.type) ||
          typeof item?.id !== 'string' ||
          !item.id ||
          typeof item.text !== 'string' ||
          (item.type !== 'reasoning' && (item.type !== 'agent_message' || item.text !== ''))
        ) {
          unsafeProgress = true
        }
      }
      if (
        frame.type === 'item.completed' &&
        frame.item?.type === 'agent_message' &&
        typeof frame.item.text === 'string'
      ) {
        answer = frame.item.text
      }
      if (frame.type === 'turn.completed') {
        completed = true
      }
      if (frame.type === 'turn.failed') {
        if (failure || typeof frame.error?.message !== 'string') {
          return { ok: false as const, quota: false }
        }
        failure = frame.error.message
      }
    }
  } catch {
    return { ok: false as const, quota: false }
  }
  if (code === 0 && completed && answer && !failure) {
    return { ok: true as const, text: answer }
  }
  // Pinned 0.166.0 CLI diagnostic plus the same credential revision's spent subscription window.
  const quota =
    code !== null &&
    code !== 0 &&
    !unsafeProgress &&
    !completed &&
    answer === undefined &&
    typeof failure === 'string' &&
    /^(?:You've|You\u2019ve) hit your usage limit\. (?:Upgrade to [^\n]+|Try again at [^\n]+)\.?$/.test(
      failure
    )
  return {
    ok: false as const,
    quota: quota && exhausted,
    diagnostic: quota,
    message: providerFailureMessage(failure)
  }
}
