// The messages a stand-in place holds, as Orca Cloud reads them, and what a bot does to one: edit or
// delete its own, or download a file on one.
import type { EvalHostState } from './bot-automation-eval-host'
import type { PlaceView } from './bot-automation-eval-connector-places'
import { slackChannelAt } from './bot-automation-eval-slack'
import type { StandInIo } from '../bot-orchestration-eval/bot-orchestration-eval-orca'

// A worker's pull request reads as its head commit and checks.
function pullAt(state: EvalHostState, text: string): { author: string; text: string }[] {
  const number = Number(/(?:#|\/pull\/)(\d+)/.exec(text)?.[1])
  const pull = Object.values(state.pulls ?? {}).find((entry) => entry.number === number)
  return pull
    ? [
        {
          author: 'GitHub',
          text: `${pull.url} · ${pull.state} · head ${String(pull.headSha).slice(0, 7)} · checks ${pull.checks}`
        }
      ]
    : []
}

type PlaceMessage = NonNullable<NonNullable<EvalHostState['places']>[number]['messages']>[number]

/** What a place holds: its own messages, the Slack world's, a known pull request, or nothing. */
export function messagesAt(state: EvalHostState, place: PlaceView) {
  const inSlack = state.places?.some((entry) => entry.ref === place.ref)
    ? null
    : slackChannelAt(place.ref)
  if (inSlack) {
    return inSlack.messages
  }
  const written: PlaceMessage[] =
    (state.places ?? []).find((entry) => entry.ref === place.ref)?.messages ??
    pullAt(state, `${place.ref} ${place.label}`)
  // A channel's message leaves the thread slot empty (slack:T:C::ts), as Orca Cloud writes it.
  const prefix = place.ref.split(':').length === 3 ? `${place.ref}::` : `${place.ref}:`
  return written.map(({ files, ...message }, index) => ({
    ref: `${prefix}m${index + 1}`,
    label: `m${index + 1}`,
    ...message,
    // As slack-actions.ts fileView lists a file: what --download takes, and what it is.
    ...(files?.length
      ? {
          files: files.map(({ id, name, type, content }) => ({
            id,
            name,
            type,
            size: Buffer.byteLength(content)
          }))
        }
      : {}),
    at: Date.now() - (written.length - index) * 3_600_000
  }))
}

// Worded as Orca Cloud's refusal (connector-actions.ts NOT_OWN).
const NOT_OWN = {
  ok: false,
  refusal: 'not_own',
  message: "That message isn't the bot's own; it edits and deletes only what it posted."
}

/** The message a ref names exactly, in whichever place lists it. */
function messageAt(state: EvalHostState, ref: string) {
  for (const place of state.places ?? []) {
    const index = messagesAt(state, place).findIndex((message) => message.ref === ref)
    const message = place.messages?.[index]
    if (place.messages && message) {
      return { place: { ...place, messages: place.messages }, index, message }
    }
  }
  return null
}

/** An edit or delete: only of a message the bot wrote, as Slack itself refuses any other. Later
 *  reads show the change. */
export function change(
  state: EvalHostState,
  verb: 'edit' | 'delete',
  params: Record<string, unknown>,
  io: StandInIo
): unknown {
  const ref = String(params.ref ?? '')
  const found = messageAt(state, ref)
  if (!found) {
    return { ok: false, refusal: 'not_found', message: `No message ${ref}.` }
  }
  if (found.message.author !== state.bots[0]?.name) {
    return NOT_OWN
  }
  io.record({ kind: 'write', method: `connector.${verb}`, params })
  const { args } = params
  const text = typeof args === 'object' && args !== null && 'text' in args ? String(args.text) : ''
  const place = (state.places ?? []).find((entry) => entry.ref === found.place.ref)!
  place.messages =
    verb === 'edit'
      ? found.place.messages.map((entry, at) => (at === found.index ? { ...entry, text } : entry))
      : found.place.messages.filter((_, at) => at !== found.index)
  io.save(state)
  return { ok: true, result: { target: { ref, label: verb === 'edit' ? 'edited' : 'deleted' } } }
}

/** A file on a message, as the cloud's read --download answers: a link its bytes stream from (here
 *  a data: URL the CLI fetches as it would Orca Cloud's), whatever its size. */
export function downloadFile(state: EvalHostState, ref: string, fileId: string): unknown {
  const found = messageAt(state, ref)
  if (!found) {
    return {
      ok: false,
      refusal: 'invalid_args',
      message: '--download needs the message ref the file is on (one `read` lists).'
    }
  }
  const file = found.message.files?.find((entry) => entry.id === fileId)
  if (!file) {
    return {
      ok: false,
      refusal: 'not_found',
      message: "That message has no such file, or Slack doesn't let the bot open it."
    }
  }
  const { id, name, type, content } = file
  const size = Buffer.byteLength(content)
  const url = `data:application/octet-stream;base64,${Buffer.from(content).toString('base64')}`
  return {
    ok: true,
    result: {
      target: { ref, label: name },
      download: { id, name, type, size, url, ticket: 'eval' }
    }
  }
}
