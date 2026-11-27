import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import { parseAgentSessionAttachmentStorePath } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import {
  AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  sanitizeAgentSessionAttachmentName
} from '../../shared/agent-session/agent-session-attachments'
import {
  imageExtension,
  MAX_ASKER_IMAGE_BYTES,
  MAX_ASKER_IMAGES
} from '../external-conversations/connector-asker-images'
import { getAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import {
  formatNativeChatFileReference,
  getAgentImageHandling
} from '../../shared/native-chat/input/composer/agent-image-paste'
import type { FeishuStore } from './feishu-store-ops'
import type { Binding } from './feishu-binding'
import { verifiedOriginal } from './feishu-message'
import type { FeishuTransport } from './feishu-transport'

export type ResourceKind = 'image' | 'file'
const imageKey = lazyZodSchema(() => z.string().regex(/^img_[a-zA-Z0-9_-]{1,192}$/))
const fileKey = lazyZodSchema(() => z.string().regex(/^file_[a-zA-Z0-9_-]{1,192}$/))
const postBody = lazyZodSchema(() =>
  z.object({ title: z.string().optional(), content: z.array(z.array(z.unknown())) })
)
const postElement = lazyZodSchema(() =>
  z.discriminatedUnion('tag', [
    z.object({ tag: z.literal('img'), image_key: imageKey }),
    z.object({ tag: z.enum(['text', 'a', 'md']), text: z.string() })
  ])
)
const savedPost = lazyZodSchema(() =>
  z.object({
    prompt: z.string(),
    storedImages: z.array(z.string()).max(MAX_ASKER_IMAGES),
    skippedImages: z.boolean().optional()
  })
)

function postInput(value: unknown): { prompt: string; keys: string[] } {
  const localized = z.record(z.string(), postBody).safeParse(value).data
  const body =
    postBody.safeParse(value).data ??
    (localized && (localized.zh_cn ?? localized.en_us ?? Object.values(localized)[0]))
  if (!body) {
    throw new Error('Unsupported Feishu post')
  }
  const keys = new Set<string>()
  const lines = body.content.map((line) =>
    line
      .map((element) => {
        const { data } = postElement.safeParse(element)
        if (!data) {
          return ''
        }
        if (data.tag === 'img') {
          if (keys.size < MAX_ASKER_IMAGES) {
            keys.add(data.image_key)
          }
          return ''
        }
        return data.text
      })
      .join('')
  )
  const text = [body.title ?? '', ...lines].filter((line) => line.trim()).join('\n')
  return { prompt: text || 'The owner sent a rich-text message in the DM.', keys: [...keys] }
}

async function fetchInput(
  api: Pick<FeishuTransport, 'original' | 'download'>,
  b: Binding,
  mid: string,
  kind: ResourceKind | 'post',
  withImages: boolean,
  signal: AbortSignal
): Promise<{ prompt: string; storedImages?: string[]; path: string }> {
  const store = getAgentSessionAttachmentStore()
  if (!store || !b.owner || !b.chat) {
    throw new Error('Attachment storage unavailable')
  }
  const content = verifiedOriginal(await api.original(mid), mid, b.chat, b.owner, kind)
  if (!content) {
    throw new Error('Could not verify the original Feishu attachment')
  }
  const value: unknown = JSON.parse(content)
  const save = async (key: string, type: ResourceKind, name: string) => {
    const bytes = await api.download(
      mid,
      key,
      type,
      type === 'image' ? MAX_ASKER_IMAGE_BYTES : AGENT_SESSION_ATTACHMENT_MAX_BYTES
    )
    const extension = type === 'image' ? imageExtension(bytes) : undefined
    if (bytes.length === 0 || (type === 'image' && !extension)) {
      throw new Error('Unsupported Feishu attachment')
    }
    signal.throwIfAborted()
    return store.storeFile(extension ? `image${extension}` : name, bytes)
  }
  if (kind === 'post') {
    const { prompt, keys } = postInput(value)
    const storedImages: string[] = []
    const missing: number[] = []
    if (withImages) {
      for (const [index, key] of keys.entries()) {
        try {
          storedImages.push(await save(key, 'image', 'image'))
        } catch {
          signal.throwIfAborted()
          missing.push(index + 1)
        }
      }
    }
    const skippedImages = !withImages && keys.length > 0
    const caption = skippedImages
      ? 'This agent cannot accept the attached images.'
      : missing.length
        ? `Could not attach inline image(s) ${missing.join(', ')}.`
        : undefined
    const input = {
      prompt: caption ? `${prompt}\n${caption}` : prompt,
      storedImages,
      skippedImages: skippedImages || missing.length > 0
    }
    return { ...input, path: JSON.stringify(input) }
  }
  if (kind === 'image') {
    const { image_key: key } = z.object({ image_key: imageKey }).parse(value)
    const path = await save(key, 'image', 'image')
    return { path, ...singleAttachmentInput(kind, path) }
  }
  const file = z
    .object({
      file_key: fileKey,
      file_name: z.string().optional(),
      file_size: z.coerce
        .number()
        .int()
        .nonnegative()
        .max(AGENT_SESSION_ATTACHMENT_MAX_BYTES)
        .optional()
    })
    .parse(value)
  const path = await save(
    file.file_key,
    kind,
    sanitizeAgentSessionAttachmentName(file.file_name || 'attachment')
  )
  return { path, ...singleAttachmentInput(kind, path) }
}

function singleAttachmentInput(kind: ResourceKind, path: string) {
  return kind === 'image'
    ? { prompt: 'The owner sent this image in the DM.', storedImages: [path] }
    : { prompt: `The owner sent a file in the DM: ${formatNativeChatFileReference(path)}` }
}

/** Unclaimed uploads may have been swept between inbox attempts. Only reuse a regular store file. */
async function storedResourceAvailable(path: string): Promise<boolean> {
  const store = getAgentSessionAttachmentStore()
  const ref = store && parseAgentSessionAttachmentStorePath(store.rootDir, path)
  if (!ref || path !== join(store.rootDir, ref.uploadId, ref.name)) {
    return false
  }
  try {
    const [dir, file] = await Promise.all([lstat(dirname(path)), lstat(path)])
    return dir.isDirectory() && file.isFile()
  } catch (error) {
    const code = errnoCodeOrUnknown(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false
    }
    throw error
  }
}

export async function feishuInput(
  api: Pick<FeishuTransport, 'original' | 'download'>,
  inbox: Pick<FeishuStore, 'stored'>,
  binding: Binding,
  row: NonNullable<Awaited<ReturnType<FeishuStore['next']>>>,
  agent: string,
  signal: AbortSignal
): Promise<{ prompt: string; storedImages?: string[] }> {
  if (row.kind === 'text') {
    return { prompt: row.body }
  }
  signal.throwIfAborted()
  const withImages = getAgentImageHandling(agent) !== 'unsupported'
  if (row.kind === 'image' && !withImages) {
    return {
      prompt: 'The owner sent an image, but this bot’s agent does not accept image attachments.'
    }
  }
  if (row.path) {
    if (row.kind === 'post') {
      const saved = savedPost.parse(JSON.parse(row.path))
      if (
        !withImages ||
        ((saved.skippedImages === false ||
          (saved.skippedImages === undefined && saved.storedImages.length > 0)) &&
          (await Promise.all(saved.storedImages.map(storedResourceAvailable))).every(Boolean))
      ) {
        return withImages ? saved : { prompt: saved.prompt }
      }
    } else if (await storedResourceAvailable(row.path)) {
      return singleAttachmentInput(row.kind, row.path)
    }
  }
  let input: Awaited<ReturnType<typeof fetchInput>>
  try {
    input = await fetchInput(api, binding, row.mid, row.kind, withImages, signal)
  } catch {
    signal.throwIfAborted()
    return {
      prompt: `The owner's ${row.kind} could not be attached. Tell the owner the attachment could not be read; do not infer its contents.`
    }
  }
  await inbox.stored(binding.account, row.mid, input.path)
  signal.throwIfAborted()
  return input
}
