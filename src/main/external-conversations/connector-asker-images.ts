import { extname } from 'node:path'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorActionResponse } from '../../shared/connector-action-contract'
import { detectImageFileSignature } from '../../shared/file-content/image-file-signature'
import type { ConnectorResult } from '../connector-cloud/connector-cloud-request'
import { PI_UNSHRUNK_IMAGE_LIMITS } from '../pi/rpc/prompts/rpc-prompt'

/** The images on a request, saved where a chat's attachments live; each path is one the agent can
 *  read as an image. Never throws: an image that can't be had is left to the agent's own download. */
export type AskerImages = (request: {
  botId: string
  conversation: { source: string; externalId: string }
  asker?: ConnectorAsker
  /** Follow-up messages carried in the same turn; their images share the turn's cap and budget. */
  later?: readonly { asker?: ConnectorAsker }[]
  /** The chat's agent, so auto-attached images stay within its own inline image limits. */
  agent?: string
  signal: AbortSignal
}) => Promise<string[]>

export const MAX_ASKER_IMAGES = 4
export const MAX_ASKER_IMAGE_BYTES = 10 * 1024 * 1024
/** Short of the cloud's lease on the delivery, which resends one not taken in time. */
export const ASKER_IMAGES_BUDGET_MS = 10_000

// A file the request lists under its words, as Orca Cloud writes one: `[image: name, file F0123]`.
const IMAGE_LINE = /^\[image: .+, file ([A-Za-z0-9]{1,64})\]$/
const FILE_LINE = /^\[(?:image|file): .+, file [A-Za-z0-9]{1,64}\]$|^\[file Slack does not show\]$/

/** The ids of the images a request lists, in order, up to the most a turn takes. Only the lines at
 *  its very end are a list: the same words typed higher up are the person's own. */
export function askerImageIds(text: string): string[] {
  const lines = text.trimEnd().split('\n')
  const ids: string[] = []
  for (let index = lines.length - 1; index >= 0 && FILE_LINE.test(lines[index]!); index -= 1) {
    const id = IMAGE_LINE.exec(lines[index]!)?.[1]
    if (id) {
      ids.unshift(id)
    }
  }
  return ids.slice(0, MAX_ASKER_IMAGES)
}

/** The extension of the image these bytes are, or null when they are not one a turn can show. */
export function imageExtension(bytes: Uint8Array): string | null {
  const signature = detectImageFileSignature(bytes)
  return signature ? `.${signature.extension}` : null
}

type Download = { name?: unknown; size?: unknown; url?: unknown; ticket?: unknown }

const isDownload = (value: unknown): value is Download =>
  typeof value === 'object' && value !== null

async function imageBytes(
  download: Download,
  request: typeof fetch,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer | null> {
  if (typeof download.url !== 'string' || typeof download.ticket !== 'string') {
    return null
  }
  if (typeof download.size === 'number' && download.size > maxBytes) {
    return null
  }
  const response = await request(download.url, {
    headers: { authorization: `Bearer ${download.ticket}` },
    signal
  })
  if (!response.ok || !response.body) {
    return null
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    // A file that says no size, or lies about it, still stops here.
    if (size > maxBytes) {
      await response.body.cancel().catch(() => {})
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// A call that may not heed the signal still ends with it: the delivery never waits past its budget.
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(new Error('out of time'))
    if (signal.aborted) {
      stop()
      return
    }
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/** Fetches a bot delivery's head and carried follow-up images; returns empty when unavailable. */
export async function fetchAskerImages(
  askerImages: AskerImages | undefined,
  chat: { bot?: { botId: string }; agent: string },
  conversation: { source: string; externalId: string },
  message: { asker?: ConnectorAsker; later?: readonly { asker?: ConnectorAsker }[] },
  signal: AbortSignal
): Promise<string[]> {
  if (!chat.bot || !askerImages || (!message.asker && !message.later?.length)) {
    return []
  }
  return await askerImages({
    botId: chat.bot.botId,
    conversation,
    asker: message.asker,
    later: message.later,
    agent: chat.agent,
    signal
  }).catch(() => [])
}

/** Fetches a request's images through Orca Cloud, as the bot's own `read --download` would. */
export function connectorAskerImages(deps: {
  /** A read of one file on the request's message, answered with where to stream it from. */
  read: (
    request: {
      botId: string
      ref: string
      fileId: string
      conversation: { source: string; externalId: string }
    },
    signal: AbortSignal
  ) => Promise<ConnectorResult<ConnectorActionResponse> | null>
  store: (name: string, bytes: Buffer) => Promise<string>
  fetch?: typeof fetch
  budgetMs?: number
}): AskerImages {
  return async ({ botId, conversation, asker, later, agent, signal }) => {
    const askers = [
      ...(asker ? [asker] : []),
      ...(later ?? []).flatMap((next) => (next.asker ? [next.asker] : []))
    ]
    const requests: { ref: string; fileId: string }[] = []
    for (const from of askers) {
      if (!from.messageRef) {
        continue
      }
      for (const fileId of askerImageIds(from.text)) {
        requests.push({ ref: from.messageRef, fileId })
        if (requests.length >= MAX_ASKER_IMAGES) {
          break
        }
      }
      if (requests.length >= MAX_ASKER_IMAGES) {
        break
      }
    }
    if (requests.length === 0) {
      return []
    }
    // Supported Pi before 1.5.1 enforces tighter unshrunk image limits; exceeding them rejects the whole turn.
    const maxImageBytes =
      agent === 'pi'
        ? Math.min(MAX_ASKER_IMAGE_BYTES, PI_UNSHRUNK_IMAGE_LIMITS.image)
        : MAX_ASKER_IMAGE_BYTES
    let remainingTotalBytes =
      agent === 'pi' ? PI_UNSHRUNK_IMAGE_LIMITS.total : MAX_ASKER_IMAGES * MAX_ASKER_IMAGE_BYTES
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(deps.budgetMs ?? ASKER_IMAGES_BUDGET_MS)
    ])
    const paths: string[] = []
    for (const { ref, fileId } of requests) {
      const limit = Math.min(maxImageBytes, remainingTotalBytes)
      if (limit <= 0) {
        break
      }
      try {
        const answer = await within(
          deps.read({ botId, ref, fileId, conversation }, bounded),
          bounded
        )
        const told = answer?.ok && answer.value.ok ? answer.value.result.download : undefined
        const download = isDownload(told) ? told : undefined
        const bytes =
          download &&
          (await within(imageBytes(download, deps.fetch ?? fetch, limit, bounded), bounded))
        const extension = bytes && imageExtension(bytes)
        if (!bytes || !extension) {
          continue
        }
        const named = typeof download?.name === 'string' ? download.name : fileId
        const base = named.slice(0, named.length - extname(named).length) || fileId
        // The disk is bounded too: a write that hangs must not hold the turn.
        paths.push(await within(deps.store(`${base}${extension}`, bytes), bounded))
        remainingTotalBytes -= bytes.byteLength
      } catch {
        // Out of time, or the cloud or the disk refused: the turn goes on with what it has.
        if (bounded.aborted) {
          break
        }
      }
    }
    return paths
  }
}
