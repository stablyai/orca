import { open, realpath } from 'node:fs/promises'
import { normalize } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'

const headerSchema = lazyZodSchema(() =>
  z.object({
    type: z.literal('session'),
    cwd: z.string().min(1),
    id: z.string().optional()
  })
)

export async function readPiSessionHeader(
  file: string
): Promise<{ cwd: string; id?: string } | null> {
  let descriptor
  try {
    descriptor = await open(file, 'r')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0)
    const data = buffer.subarray(0, bytesRead).toString('utf8')
    // OMP writes a `title` line ahead of the header; Pi starts with the header itself.
    for (const line of data.split('\n')) {
      if (!line.trim()) {
        throw new Error('Pi session header is incomplete or oversized')
      }
      const frame: unknown = JSON.parse(line)
      if (
        typeof frame === 'object' &&
        frame !== null &&
        'type' in frame &&
        frame.type === 'title'
      ) {
        continue
      }
      return headerSchema.parse(frame)
    }
    throw new Error('Pi session header is incomplete or oversized')
  } finally {
    await descriptor.close()
  }
}

export async function samePiDirectory(left: string, right: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> =>
    realpath(value).catch(() => normalize(value))
  const [a, b] = await Promise.all([canonical(left), canonical(right)])
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
