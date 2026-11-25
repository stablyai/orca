import { StringDecoder } from 'node:string_decoder'
import type { ProviderRelayRecordTaking } from '../../provider-relay/relayed-provider-consumption'

const UUID_KEY = '"uuid":"'
/** An answer to this app's own request: the SDK takes it on read and never yields it. */
const CONTROL_ANSWER = '{"type":"control_response"'
/** Marks a held line that counts as taken as soon as every line before it is. */
const TAKEN_ON_REACH = ''

/** The message's own id: its last unescaped `"uuid":"` key, which the CLI writes after the body. */
function lineUuid(line: string): string | null {
  const at = line.lastIndexOf(UUID_KEY)
  if (at === -1) {
    return null
  }
  const start = at + UUID_KEY.length
  const end = line.indexOf('"', start)
  // Parsed, not sliced: a slice would keep the whole line alive for as long as its id is held.
  if (end === -1) {
    return null
  }
  // A nested key can carry an escaped quote; an unreadable id only holds acks back.
  try {
    const id: unknown = JSON.parse(line.slice(at + UUID_KEY.length - 1, end + 1))
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

/**
 * The SDK reads a relayed agent's lines as they come and queues their messages while Orca's reader
 * waits, so acks follow the messages Orca handled, matched by id. A control answer counts once
 * every line before it does, so an idle chat's answers can't pile up; another line the SDK keeps to
 * itself counts once a later message is handled.
 */
export function claudeRelaySdkRecordTaking(records: ProviderRelayRecordTaking): {
  /** Each chunk the SDK reads, in the same tick. */
  observe: (chunk: Buffer | string) => void
  /** After Orca handled a message the SDK yielded. */
  handled: (message: Record<string, unknown>) => void
} {
  records.claim()
  const decoder = new StringDecoder('utf8')
  let partial = ''
  let ids: (string | null)[] = []
  let head = 0
  const compact = (): void => {
    if (head > 1_024 && head * 2 > ids.length) {
      ids = ids.slice(head)
      head = 0
    }
  }
  const takeReached = (): void => {
    while (head < ids.length && ids[head] === TAKEN_ON_REACH) {
      ids[head] = null
      head += 1
      records.taken()
    }
    compact()
  }
  return {
    observe: (chunk) => {
      const parts = (partial + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).split(
        '\n'
      )
      partial = parts.pop() ?? ''
      for (const part of parts) {
        if (part.length === 0) {
          continue
        }
        if (!part.startsWith(CONTROL_ANSWER)) {
          ids.push(lineUuid(part))
        } else {
          ids.push(TAKEN_ON_REACH)
          // The relay counts a line only after handing it on, which reaches this read first.
          queueMicrotask(takeReached)
        }
      }
    },
    handled: (message) => {
      const id = typeof message.uuid === 'string' ? message.uuid : null
      const at = id === null || id === TAKEN_ON_REACH ? -1 : ids.indexOf(id, head)
      if (at === -1) {
        return
      }
      while (head <= at) {
        ids[head] = null
        head += 1
        records.taken()
      }
      takeReached()
    }
  }
}
