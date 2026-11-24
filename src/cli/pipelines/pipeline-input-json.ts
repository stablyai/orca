import { lstat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import type { HandlerContext } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'

export async function readPipelineText(
  ctx: HandlerContext,
  limit = 65536,
  strict = false
): Promise<string> {
  const size = limit === 65536 ? '64 KiB' : '320 KiB'
  const invalid = () =>
    new RuntimeClientError(
      'invalid_argument',
      `Pipeline JSON must be a regular UTF-8 file of at most ${size}`
    )
  if (ctx.flags.has('input-json')) {
    if (ctx.flags.has('input-file')) {
      throw new RuntimeClientError('invalid_argument', 'Choose one pipeline input')
    }
    const text = getRequiredStringFlag(ctx.flags, 'input-json')
    if (Buffer.byteLength(text) > 65536) {
      throw invalid()
    }
    return text
  }
  const path = resolve(ctx.cwd, getRequiredStringFlag(ctx.flags, 'input-file'))
  const before = strict ? await lstat(path) : undefined
  if (before && (!before.isFile() || before.isSymbolicLink() || before.size > limit)) {
    throw invalid()
  }
  const file = await open(
    path,
    strict
      ? constants.O_RDONLY |
          (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
      : 'r'
  )
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size > limit ||
      (before && (before.ino !== stat.ino || before.dev !== stat.dev))
    ) {
      throw invalid()
    }
    const buffer = Buffer.alloc(limit + 1)
    let total = 0
    while (total < buffer.length) {
      const read = await file.read(buffer, total, buffer.length - total, total)
      if (!read.bytesRead) {
        break
      }
      total += read.bytesRead
    }
    if (total > limit) {
      throw invalid()
    }
    const bytes = buffer.subarray(0, total)
    return strict ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('utf8')
  } finally {
    await file.close()
  }
}
export async function readPipelineInput(
  ctx: HandlerContext,
  limit = 65536,
  strict = false
): Promise<unknown> {
  return JSON.parse(await readPipelineText(ctx, limit, strict))
}
