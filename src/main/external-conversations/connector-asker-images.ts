import { extname } from 'node:path'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorActionResponse } from '../../shared/connector-action-contract'
import type { ConnectorResult } from '../connector-cloud/connector-cloud-request'

/** The images on a request, saved where a chat's attachments live; each path is one the agent can
 *  read as an image. Never throws: an image that can't be had is left to the agent's own download. */
export type AskerImages = (request: {
  botId: string
  conversation: { source: string; externalId: string }
  asker: ConnectorAsker
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

// What an image's first bytes say it is; the agent is told this, never the name Slack gave.
const SIGNATURES: readonly { extension: string; starts: readonly number[]; at?: number }[] = [
  { extension: '.png', starts: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { extension: '.jpg', starts: [0xff, 0xd8, 0xff] },
  { extension: '.gif', starts: [0x47, 0x49, 0x46, 0x38] },
  // RIFF....WEBP
  { extension: '.webp', starts: [0x57, 0x45, 0x42, 0x50], at: 8 }
]

/** The extension of the image these bytes are, or null when they are not one a turn can show. */
export function imageExtension(bytes: Uint8Array): string | null {
  return (
    SIGNATURES.find(({ starts, at = 0 }) => starts.every((byte, i) => bytes[at + i] === byte))
      ?.extension ?? null
  )
}

type Download = { name?: unknown; size?: unknown; url?: unknown; ticket?: unknown }

const isDownload = (value: unknown): value is Download =>
  typeof value === 'object' && value !== null

async function imageBytes(
  download: Download,
  request: typeof fetch,
  signal: AbortSignal
): Promise<Buffer | null> {
  if (typeof download.url !== 'string' || typeof download.ticket !== 'string') {
    return null
  }
  if (typeof download.size === 'number' && download.size > MAX_ASKER_IMAGE_BYTES) {
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
    if (size > MAX_ASKER_IMAGE_BYTES) {
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
  return async ({ botId, conversation, asker, signal }) => {
    const ids = asker.messageRef ? askerImageIds(asker.text) : []
    if (ids.length === 0 || !asker.messageRef) {
      return []
    }
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(deps.budgetMs ?? ASKER_IMAGES_BUDGET_MS)
    ])
    const paths: string[] = []
    for (const fileId of ids) {
      try {
        const answer = await within(
          deps.read({ botId, ref: asker.messageRef, fileId, conversation }, bounded),
          bounded
        )
        const told = answer?.ok && answer.value.ok ? answer.value.result.download : undefined
        const download = isDownload(told) ? told : undefined
        const bytes =
          download && (await within(imageBytes(download, deps.fetch ?? fetch, bounded), bounded))
        const extension = bytes && imageExtension(bytes)
        if (!bytes || !extension) {
          continue
        }
        const named = typeof download?.name === 'string' ? download.name : fileId
        const base = named.slice(0, named.length - extname(named).length) || fileId
        // The disk is bounded too: a write that hangs must not hold the turn.
        paths.push(await within(deps.store(`${base}${extension}`, bytes), bounded))
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
