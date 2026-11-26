import { extname } from 'node:path'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import {
  isConnectorFileId,
  isImageFileType,
  isSlackMessageRef
} from '../../shared/connector-asker-file-validation'
import type { ConnectorActionResponse } from '../../shared/connector-action-contract'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import type { ConnectorResult } from '../connector-cloud/connector-cloud-request'

export type ConnectorImage = { path: string; fileId: string; bytes: number }

export type EarlierImageBudget = {
  count: number
  bytes: number
  fileIds: ReadonlySet<string>
  maxImageBytes?: number
}

/** The images on a request, saved where a chat's attachments live; each path is one the agent can
 *  read as an image. Never throws: an image that can't be had is left to the agent's own download. */
export type AskerImages = (request: {
  botId: string
  conversation: { source: string; externalId: string }
  asker: ConnectorAsker
  signal: AbortSignal
  earlierBudget?: (
    direct: readonly ConnectorImage[],
    signal: AbortSignal
  ) => Promise<EarlierImageBudget>
}) => Promise<ConnectorImage[]>

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

type ImageTarget = { ref: string; fileId: string }

function* earlierImageTargets(asker: ConnectorAsker): Generator<ImageTarget> {
  const messages = asker.earlierOwn?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (!message.messageRef || !isSlackMessageRef(message.messageRef)) {
      continue
    }
    for (const file of message.files ?? []) {
      if (isConnectorFileId(file.id) && isImageFileType(file.type)) {
        yield { ref: message.messageRef, fileId: file.id }
      }
    }
  }
}

export function hasEarlierImages(source: string, asker: ConnectorAsker | undefined): boolean {
  return source === 'slack' && asker !== undefined && !earlierImageTargets(asker).next().done
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
const SIGNATURE_BYTES = 12

const isDownload = (value: unknown): value is Download =>
  typeof value === 'object' && value !== null

async function imageBytes(
  download: Download,
  request: typeof fetch,
  signal: AbortSignal,
  maxBytes: number
): Promise<{ bytes: Buffer; extension: string } | null> {
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
  const prefix = Buffer.alloc(SIGNATURE_BYTES)
  let extension: string | null = null
  let size = 0
  for await (const chunk of response.body) {
    if (size < SIGNATURE_BYTES) {
      prefix.set(chunk.subarray(0, SIGNATURE_BYTES - size), size)
    }
    size += chunk.length
    // A file that says no size, or lies about it, still stops here.
    if (size > maxBytes) {
      return null
    }
    if (extension === null && size >= SIGNATURE_BYTES) {
      extension = imageExtension(prefix)
      if (extension === null) {
        return null
      }
    }
    chunks.push(chunk)
  }
  extension ??= imageExtension(prefix.subarray(0, size))
  return extension ? { bytes: Buffer.concat(chunks, size), extension } : null
}

/** Fetches a request's images through Orca Cloud, as the bot's own `read --download` would. */
export type ReadConnectorImage = (
  request: {
    botId: string
    ref: string
    fileId: string
    conversation: { source: string; externalId: string }
  },
  signal: AbortSignal
) => Promise<ConnectorResult<ConnectorActionResponse> | null>

export function connectorAskerImages(deps: {
  /** Binds the reads in one delivery to the poll connection that supplied it. */
  reader: () => ReadConnectorImage | null
  store: (name: string, bytes: Buffer, slackFileId?: string) => Promise<string>
  fetch?: typeof fetch
  budgetMs?: number
}): AskerImages {
  return async ({ botId, conversation, asker, signal, earlierBudget }) => {
    const current = asker.messageRef ? askerImageIds(asker.text) : []
    const earlier = hasEarlierImages(conversation.source, asker)
    if (current.length === 0 && !earlier) {
      return []
    }
    const read = deps.reader()
    if (!read) {
      return []
    }
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(deps.budgetMs ?? ASKER_IMAGES_BUDGET_MS)
    ])
    const images: ConnectorImage[] = []
    const seen = new Set<string>()
    const stage = async ({ ref, fileId }: ImageTarget, maxBytes: number): Promise<number> => {
      try {
        const answer = await waitForPromiseWithSignal(
          read({ botId, ref, fileId, conversation }, bounded),
          bounded
        )
        const told = answer?.ok && answer.value.ok ? answer.value.result.download : undefined
        const download = isDownload(told) ? told : undefined
        const image =
          download &&
          (await waitForPromiseWithSignal(
            imageBytes(download, deps.fetch ?? fetch, bounded, maxBytes),
            bounded
          ))
        if (!image) {
          return 0
        }
        const { bytes, extension } = image
        const named = typeof download?.name === 'string' ? download.name : fileId
        const base = named.slice(0, named.length - extname(named).length) || fileId
        // The disk is bounded too: a write that hangs must not hold the turn.
        const path = await waitForPromiseWithSignal(
          deps.store(
            `${base}${extension}`,
            bytes,
            conversation.source === 'slack' ? fileId : undefined
          ),
          bounded
        )
        images.push({ path, fileId, bytes: bytes.byteLength })
        return bytes.byteLength
      } catch {
        return 0
      }
    }
    for (const fileId of current) {
      if (bounded.aborted || seen.has(fileId)) {
        continue
      }
      seen.add(fileId)
      await stage({ ref: asker.messageRef!, fileId }, MAX_ASKER_IMAGE_BYTES)
    }
    if (earlier && !bounded.aborted && seen.size < MAX_ASKER_IMAGES) {
      let budget: EarlierImageBudget | undefined
      try {
        budget =
          earlierBudget && (await waitForPromiseWithSignal(earlierBudget(images, bounded), bounded))
      } catch {
        return images
      }
      let slots = Math.min(budget?.count ?? MAX_ASKER_IMAGES, MAX_ASKER_IMAGES - seen.size)
      let bytes = budget?.bytes ?? MAX_ASKER_IMAGES * MAX_ASKER_IMAGE_BYTES
      for (const target of earlierImageTargets(asker)) {
        if (slots <= 0 || bytes <= 0 || bounded.aborted) {
          break
        }
        if (seen.has(target.fileId) || budget?.fileIds.has(target.fileId)) {
          continue
        }
        seen.add(target.fileId)
        slots -= 1
        bytes -= await stage(
          target,
          Math.min(budget?.maxImageBytes ?? MAX_ASKER_IMAGE_BYTES, bytes)
        )
      }
    }
    return images
  }
}
