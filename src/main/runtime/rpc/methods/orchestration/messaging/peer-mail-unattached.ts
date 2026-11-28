// A `send --on --file` that stored no mail after files reached the server says what it left there:
// files it knows were copied, one that may have been (its commit's answer never came back), and
// whether the server still holds them for a chat or will clear them as unused uploads.
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

// The server may yet have done what an error ending in one of these asked: its answer never came
// back, or came back unreadable.
const MAYBE_DONE = new Set([
  'runtime_timeout',
  'remote_runtime_unavailable',
  'runtime_unavailable',
  'invalid_runtime_response',
  'remote_link_closed',
  'delivery_in_progress',
  'operation_unknown',
  'outcome_unknown'
])

/** The server answered that it refused, so it stored nothing for this call. */
export function peerMailStoredNothing(error: unknown): boolean {
  if (!(error instanceof OrchestrationError) || MAYBE_DONE.has(error.code)) {
    return false
  }
  const data: unknown = error.data
  return (
    typeof data !== 'object' ||
    data === null ||
    !('effectsApplied' in data) ||
    data.effectsApplied === false
  )
}

export type UnattachedUploads = {
  /** Files the server confirmed it stored. */
  copied: number
  /** One more whose commit may have stored it: its answer never came back. */
  maybeOneMore?: boolean
}

/** `error`, from a send that stored no mail, saying what files it left on `server`. */
export function withUnattachedUploads(
  error: unknown,
  server: { name: string },
  { copied, maybeOneMore = false }: UnattachedUploads
): unknown {
  if (copied === 0 && !maybeOneMore) {
    return error
  }
  const known = error instanceof OrchestrationError
  const data: object =
    known && typeof error.data === 'object' && error.data !== null ? error.data : {}
  const kept =
    (known && error.code === 'peer_mail_files_kept') ||
    ('filesKept' in data && data.filesKept === true)
  // The cause, then what happened, then what to do: a retry hint moves to the end.
  const text = error instanceof Error ? error.message : String(error)
  const again = / ?Send it again\.$/.test(text) ? ' Send it again.' : ''
  const reason = text
    .replace(/ ?Send it again\.$/, '')
    .replace(/ ?(Nothing was sent|No message was sent|Nothing was delivered)\.$/, '')
    .replace(/([^.])$/, '$1.')
  // What the server said about effects described only its own refusal, not these files.
  const rest = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'effectsApplied'))
  // One code the CLI hears across this Orca's own RPC, with the refusal's own code as its cause.
  return new OrchestrationError(
    'peer_mail_not_sent',
    `${reason} The message wasn't sent. ${note(server.name, copied, maybeOneMore, kept)}${again}`,
    {
      ...rest,
      ...(known && error.code !== 'peer_mail_files_kept' ? { cause: error.code } : {}),
      ...(kept ? { filesKept: true } : {}),
      // Copied files are an effect; one that only may have been leaves it unknown.
      ...(copied > 0 ? { effectsApplied: true } : {}),
      unattachedUploads: copied,
      ...(maybeOneMore ? { maybeUploadedOneMore: true } : {})
    }
  )
}

function note(server: string, copied: number, maybeOneMore: boolean, kept: boolean): string {
  const files = copied === 1 ? 'A file' : `${copied} files`
  if (copied === 0) {
    return `A file may have been copied to ${server} for it; if so, it is attached to nothing there, and Orca on ${server} clears unused uploads later.`
  }
  const more = maybeOneMore ? ', and maybe one more,' : ''
  const plural = copied > 1 || maybeOneMore
  return kept
    ? `${files} already copied to ${server} for it${more} ${plural ? 'are' : 'is'} still held there by a chat; Orca on ${server} removes ${plural ? 'them' : 'it'} with that chat.`
    : `${files} already copied to ${server} for it${more} ${plural ? 'are' : 'is'} attached to nothing there; Orca on ${server} clears unused uploads later.`
}
