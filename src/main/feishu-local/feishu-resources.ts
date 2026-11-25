import { lstat, mkdtemp, open, readdir, rm, stat, watch } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import { parseAgentSessionAttachmentStorePath } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import { z } from 'zod'
import { runProcess } from '@orca/process-host'
import {
  AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  sanitizeAgentSessionAttachmentName
} from '../../shared/agent-session/agent-session-attachments'
import {
  imageExtension,
  MAX_ASKER_IMAGE_BYTES
} from '../external-conversations/connector-asker-images'
import { getAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import {
  formatNativeChatFileReference,
  getAgentImageHandling
} from '../../shared/native-chat/input/composer/agent-image-paste'
import type { FeishuStore } from './feishu-store-ops'
import type { Binding } from './feishu-binding'
import { originalContent, postImageKeys, readOriginal } from './feishu-original-message'

export type ResourceKind = 'image' | 'file'
const resource = z.object({
  image_key: z
    .string()
    .regex(/^img_[a-zA-Z0-9_-]{1,192}$/)
    .optional(),
  file_key: z
    .string()
    .regex(/^file_[a-zA-Z0-9_-]{1,192}$/)
    .optional(),
  file_name: z.string().optional(),
  file_size: z.coerce.number().int().nonnegative().optional()
})
export function originalResource(value: unknown, b: Binding, mid: string, kind: ResourceKind) {
  const content = originalContent(value, b, mid, kind)
  if (content === null) {
    return null
  }
  try {
    const data = resource.parse(JSON.parse(content))
    const key = kind === 'image' ? data.image_key : data.file_key
    return key
      ? {
          key,
          name: sanitizeAgentSessionAttachmentName(data.file_name || 'attachment'),
          size: data.file_size
        }
      : null
  } catch {
    return null
  }
}

async function storeFeishuResource(
  b: Binding,
  mid: string,
  kind: ResourceKind,
  meta: { key: string; name: string; size?: number } | null,
  signal: AbortSignal
): Promise<string> {
  const store = getAgentSessionAttachmentStore()
  if (!store || !b.owner || !b.chat) {
    throw new Error('Attachment storage unavailable')
  }
  const limit =
    kind === 'image'
      ? Math.min(AGENT_SESSION_ATTACHMENT_MAX_BYTES, MAX_ASKER_IMAGE_BYTES)
      : AGENT_SESSION_ATTACHMENT_MAX_BYTES
  if (!meta || (meta.size !== undefined && meta.size > limit)) {
    throw new Error('Unsupported Feishu attachment')
  }
  const dir = await mkdtemp(join(tmpdir(), 'orca-feishu-'))
  const file = join(dir, 'resource.bin')
  const controller = new AbortController()
  const stop = AbortSignal.any([signal, controller.signal])
  const monitor = (async () => {
    try {
      for await (const event of watch(dir, { signal: stop })) {
        const names = event.filename ? [event.filename] : await readdir(dir)
        for (const name of names) {
          const size = await stat(join(dir, name)).then(
            (s) => s.size,
            () => 0
          )
          if (size > limit) {
            controller.abort()
            return
          }
        }
      }
    } catch {
      if (!stop.aborted) {
        controller.abort()
      }
    }
  })()
  try {
    const reply = await runProcess({
      program: 'lark-cli',
      args: [
        '--profile',
        b.app,
        'im',
        '+messages-resources-download',
        '--as',
        'bot',
        '--message-id',
        mid,
        '--type',
        kind,
        '--file-key',
        meta.key,
        '--output',
        'resource.bin'
      ],
      cwd: dir,
      detached: process.platform !== 'win32',
      signal: stop,
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024
    })
    if (reply.code !== 0 || stop.aborted) {
      throw new Error('Could not download Feishu attachment')
    }
    const h = await open(file, 'r')
    try {
      const info = await h.stat()
      if (!info.isFile() || info.size <= 0 || info.size > limit) {
        throw new Error('Unsupported Feishu attachment size')
      }
      const bytes = await h.readFile()
      const extension = imageExtension(bytes)
      if (kind === 'image' && !extension) {
        throw new Error('Unsupported Feishu image')
      }
      stop.throwIfAborted()
      return await store.storeFile(kind === 'image' ? `image${extension}` : meta.name, bytes)
    } finally {
      await h.close()
    }
  } finally {
    controller.abort()
    await monitor
    await rm(dir, { recursive: true, force: true })
  }
}

/** The resource and any follow-up reach the same native conversation through the normal start. */
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

// A post's images the turn sees at most; the rest are named in its words.
const POST_IMAGES = 4
const POST_IMAGE = /!\[[^\]\n]*\]\((img_[a-zA-Z0-9_-]{1,192})\)/g

/** A rich-text post: its words as the CLI flattened them, its images verified on the original. */
async function postInput(
  binding: Binding,
  row: { mid: string; body: string },
  agent: string,
  signal: AbortSignal
): Promise<{ prompt: string; storedImages?: string[] }> {
  const text = row.body.replace(POST_IMAGE, '[image]').trim()
  const shown = [...row.body.matchAll(POST_IMAGE)].length
  if (shown === 0) {
    return { prompt: text }
  }
  if (getAgentImageHandling(agent) === 'unsupported') {
    return {
      prompt: `${text}\n\n(The owner's post holds images this bot’s agent can’t see. Tell the owner if they matter.)`
    }
  }
  const keys = await readOriginal(binding, row.mid, signal).then(
    (value) => postImageKeys(value, binding, row.mid),
    () => []
  )
  signal.throwIfAborted()
  const storedImages: string[] = []
  for (const key of keys.slice(0, POST_IMAGES)) {
    try {
      storedImages.push(
        await storeFeishuResource(binding, row.mid, 'image', { key, name: 'image' }, signal)
      )
    } catch {
      signal.throwIfAborted()
    }
  }
  const missing = Math.max(shown, keys.length) - storedImages.length
  const note =
    missing > 0
      ? `\n\n(${missing} of the post's images could not be attached; do not infer their contents.)`
      : ''
  return { prompt: `${text}${note}`, ...(storedImages.length > 0 ? { storedImages } : {}) }
}

export async function feishuInput(
  inbox: Pick<FeishuStore, 'stored'>,
  binding: Binding,
  row: Exclude<NonNullable<Awaited<ReturnType<FeishuStore['next']>>>, { kind: 'unsupported' }>,
  agent: string,
  signal: AbortSignal
): Promise<{ prompt: string; storedImages?: string[] }> {
  if (row.kind === 'text') {
    return { prompt: row.body }
  }
  if (row.kind === 'post') {
    return postInput(binding, row, agent, signal)
  }
  if (row.kind === 'image' && getAgentImageHandling(agent) === 'unsupported') {
    return {
      prompt:
        'The owner sent an image, but this bot’s agent does not accept image attachments. Tell the owner to choose an image-capable agent or describe the image.'
    }
  }
  let path = row.path
  if (!path || !(await storedResourceAvailable(path))) {
    signal.throwIfAborted()
    try {
      const meta = originalResource(
        await readOriginal(binding, row.mid, signal),
        binding,
        row.mid,
        row.kind
      )
      path = await storeFeishuResource(binding, row.mid, row.kind, meta, signal)
    } catch {
      signal.throwIfAborted()
      return {
        prompt: `The owner's ${row.kind} could not be attached. Tell the owner the attachment could not be read; do not infer its contents.`
      }
    }
    await inbox.stored(binding.account, row.mid, path)
  }
  signal.throwIfAborted()
  return row.kind === 'image'
    ? { prompt: 'The owner sent this image in the DM.', storedImages: [path] }
    : { prompt: `The owner sent a file in the DM: ${formatNativeChatFileReference(path)}` }
}
