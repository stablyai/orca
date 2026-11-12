import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { readNodeFileHandleWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { antigravityUserHome } from './antigravity-chat-user-skills'

const MAX_DIRECTORIES = 128
const MAX_FILE_BYTES = 24_000
const MAX_INLINE_BYTES = 80_000
const MAX_POINTER_BYTES = 8_000
const RULE_NAMES = ['GEMINI.md', 'AGENTS.md'] as const
const REMAINING_RULES =
  'Additional instructions are available in GEMINI.md in your user .gemini directory and in GEMINI.md or AGENTS.md from the workspace directory up to the repository root.'
const appendCapability = z.object({
  antigravity: z.object({ systemPrompt: z.object({ append: z.literal(true) }) })
})

async function workspaceRuleDirectories(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const directories: string[] = []
  let directory = resolve(cwd)
  for (let depth = 0; depth < MAX_DIRECTORIES; depth++) {
    signal?.throwIfAborted()
    directories.push(directory)
    const marker = await stat(join(directory, '.git')).catch(() => null)
    if (marker?.isDirectory() || marker?.isFile()) {
      return directories.toReversed()
    }
    const parent = dirname(directory)
    if (parent === directory) {
      break
    }
    directory = parent
  }
  return [resolve(cwd)]
}

/** The managed server has no native rules discovery; its advertised append is activation-scoped. */
export const antigravityChatRulesMeta: NonNullable<AcpLaunchSpec['resolveSessionMeta']> = async ({
  initialized,
  cwd,
  env,
  signal
}) => {
  if (!appendCapability.safeParse(initialized.agentCapabilities?._meta).success) {
    return undefined
  }
  const directories = await workspaceRuleDirectories(cwd, signal)
  const files = [
    join(antigravityUserHome(env), '.gemini', 'GEMINI.md'),
    ...directories.flatMap((directory) => RULE_NAMES.map((name) => join(directory, name)))
  ]
  const seen = new Set<string>()
  const sections: string[] = []
  const pointers: string[] = []
  let inlineBytes = 0
  let readBytes = 0
  let pointerBytes = 0
  let remaining = false
  const pointTo = (path: string) => {
    const pointer = `Additional instructions: ${path}`
    const bytes = Buffer.byteLength(pointer) + 2
    if (pointerBytes + bytes <= MAX_POINTER_BYTES) {
      pointers.push(pointer)
      pointerBytes += bytes
    } else {
      remaining = true
    }
  }
  for (const file of files) {
    signal?.throwIfAborted()
    try {
      const path = await realpath(file)
      signal?.throwIfAborted()
      const identity = process.platform === 'win32' ? path.toLowerCase() : path
      if (seen.has(identity)) {
        continue
      }
      seen.add(identity)
      const info = await stat(path)
      signal?.throwIfAborted()
      if (!info.isFile() || info.size === 0) {
        continue
      }
      const header = `Instructions from ${path}:\n`
      const available = Math.max(0, MAX_INLINE_BYTES - inlineBytes - Buffer.byteLength(header) - 2)
      const length = Math.min(info.size, MAX_FILE_BYTES, available, MAX_INLINE_BYTES - readBytes)
      if (length === 0) {
        pointTo(path)
        if (remaining) {
          break
        }
        continue
      }
      const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
      readBytes += length
      const handle = await open(path, flags)
      const { buffer } = await readNodeFileHandleWithinLimit(handle, length, {
        regularFileOnly: true,
        signal,
        window: { offset: 0, length }
      }).finally(() => handle.close())
      if (buffer.includes(0)) {
        continue
      }
      // A complete line also avoids splitting a UTF-8 sequence at the read boundary.
      const truncated = info.size > length
      const complete = truncated ? buffer.subarray(0, Math.max(0, buffer.lastIndexOf(10))) : buffer
      const content = new TextDecoder('utf-8', { fatal: true }).decode(complete).trim()
      if (content) {
        const section = header + content
        sections.push(section)
        inlineBytes += Buffer.byteLength(section) + 2
      }
      if (truncated) {
        pointTo(path)
      }
    } catch {
      // Missing or unreadable rules never prevent starting a chat.
      signal?.throwIfAborted()
    }
  }
  signal?.throwIfAborted()
  const append = [...sections, ...pointers, ...(remaining ? [REMAINING_RULES] : [])].join('\n\n')
  return append ? { antigravity: { systemPrompt: { append } } } : undefined
}
