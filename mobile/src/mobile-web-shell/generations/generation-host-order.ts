import { z } from 'zod'
import { joinUri } from './generation-cache-uri'
import type { GenerationFileSystem } from './generation-store-file-system'

const HOST_INDEX_FILE_NAME = 'hosts.json'

// Recency only: unreadable or legacy timestamp indexes count as empty, making unlisted hosts first to evict.
const HostOrderSchema = z.array(z.string())

export type GenerationHostOrder = {
  read(): Promise<readonly string[]>
  write(order: readonly string[]): Promise<void>
  // No eviction pass: touching recency does not add a host.
  touch(hostKey: string): Promise<void>
}

// The generation store's least-recently-used host index.
export function createGenerationHostOrder(fs: GenerationFileSystem): GenerationHostOrder {
  const indexUri = joinUri(fs.rootUri, HOST_INDEX_FILE_NAME)
  async function read(): Promise<readonly string[]> {
    // Index read failures lose eviction order only; the next activation rewrites it.
    const text = await fs.readText(indexUri).catch(() => null)
    const parsed = text === null ? null : HostOrderSchema.safeParse(parseJson(text))
    return parsed?.success === true ? parsed.data : []
  }
  async function write(order: readonly string[]): Promise<void> {
    // Index write failures must not reject an activation already on disk; the next activation rewrites it.
    await fs.writeText(indexUri, JSON.stringify(order)).catch(() => undefined)
  }
  return {
    read,
    write,
    touch: async (hostKey) => {
      const order = await read()
      if (order.at(-1) !== hostKey) {
        await write(withHostLast(order, hostKey))
      }
    }
  }
}

export function withHostLast(order: readonly string[], hostKey: string): string[] {
  return [...order.filter((key) => key !== hostKey), hostKey]
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
