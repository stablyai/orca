// The Slack thread that woke the bot, as the cloud treats it (v3): `orca bot reply --file` attaches
// there, and a `orca slack post` or `attach` aimed at it is refused with `use_reply`.
import type { EvalHostState } from './bot-automation-eval-host'
import { EVAL_UPLOAD_PREFIX } from './bot-automation-eval-artifacts'
import { ConnectorActionArgs } from '../../shared/connector-action-contract'
import WORLD from './bot-automation-eval-slack-world.json'
import type { StandInIo } from '../bot-orchestration-eval/bot-orchestration-eval-orca'

const USE_REPLY =
  'That\'s the thread that woke you: answer there with `orca bot reply --text "..."` (your final message is posted there too).'

/** A stage call: a file's upload slot, which the CLI sends its bytes to (data: here, as Slack's URL
 *  takes them there). */
export function isStaging(params: Record<string, unknown>): boolean {
  const args: unknown = params.args
  return typeof args === 'object' && args !== null && 'stage' in args && args.stage === true
}

export const STAGED = (ref: string, label: string) => ({
  ok: true,
  result: { target: { ref, label }, staged: true, upload: { url: 'data:,' } }
})

/** The waking thread's ref; null outside a Slack conversation. */
export function wakingThreadRef(state: Pick<EvalHostState, 'conversation'>): string | null {
  if (state.conversation?.source !== 'slack') {
    return null
  }
  const { channel, thread } = state.conversation.slack ?? {
    channel: WORLD.conversationChannel,
    thread: WORLD.conversationThread
  }
  return `slack:${WORLD.teamId}:${channel}:${thread}`
}

/** The waking thread's answer to this verb on this place; undefined when it isn't involved. */
export function serveWakingThread(
  state: EvalHostState,
  verb: string,
  placeRef: string | undefined,
  params: Record<string, unknown>,
  io: StandInIo
): unknown {
  const thread = wakingThreadRef(state)
  if (verb === 'reply') {
    if (!thread) {
      return { ok: false, refusal: 'no_waking_thread', message: 'No Slack thread woke you.' }
    }
    if (isStaging(params) && state.filesRefused) {
      return {
        ok: false,
        refusal: 'post_failed',
        message: "Slack didn't take the file; nothing was posted."
      }
    }
    const args = ConnectorActionArgs.parse(params.args ?? {})
    if (isStaging(params)) {
      io.record({ kind: 'write', method: 'connector.stage', params, result: { target: thread } })
      const staged = STAGED(thread, 'this thread')
      staged.result.upload.url = EVAL_UPLOAD_PREFIX + encodeURIComponent(args.postId ?? '')
      return staged
    }
    io.record({
      kind: 'write',
      method: 'connector.reply',
      params: { ...params, ref: thread },
      result: { target: thread }
    })
    return { ok: true, result: { target: { ref: thread, label: 'this thread' } } }
  }
  if (thread && (verb === 'post' || verb === 'attach') && placeRef?.startsWith(thread)) {
    return { ok: false, refusal: 'use_reply', message: USE_REPLY }
  }
  return undefined
}
