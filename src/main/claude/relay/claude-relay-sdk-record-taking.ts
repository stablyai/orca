import { StringDecoder } from 'node:string_decoder'
import type { ProviderRelayRecordTaking } from '../../provider-relay/relayed-provider-consumption'

const UUID_KEY = '"uuid":"'

/** The message's own id: its last unescaped `"uuid":"` key, which the CLI writes after the body. */
function lineUuid(line: string): string | null {
  const at = line.lastIndexOf(UUID_KEY)
  if (at === -1) {
    return null
  }
  const start = at + UUID_KEY.length
  const end = line.indexOf('"', start)
  return end === -1 ? null : line.slice(start, end)
}

/**
 * The SDK reads a relayed agent's lines as they come and queues their messages while Orca's reader
 * waits, so acks follow the messages Orca handled, matched by id. A line the SDK keeps to itself (a
 * control answer, a keep-alive) counts once a later message is handled.
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
  return {
    observe: (chunk) => {
      const parts = (partial + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).split(
        '\n'
      )
      partial = parts.pop() ?? ''
      for (const part of parts) {
        if (part.length > 0) {
          ids.push(lineUuid(part))
        }
      }
    },
    handled: (message) => {
      const id = typeof message.uuid === 'string' ? message.uuid : null
      const at = id === null ? -1 : ids.indexOf(id, head)
      if (at === -1) {
        return
      }
      while (head <= at) {
        head += 1
        records.taken()
      }
      if (head > 1_024 && head * 2 > ids.length) {
        ids = ids.slice(head)
        head = 0
      }
    }
  }
}
