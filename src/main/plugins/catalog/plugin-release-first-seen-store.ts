import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { writePluginFileAtomically } from '../installation/plugin-atomic-file-write'

const firstSeenSchema = z.record(
  z.string().max(256),
  z.object({ release: z.string().max(512), firstSeenAt: z.number().finite().nonnegative() })
)

/**
 * When this Orca first saw each plugin's newest catalog release. Why local: catalogs carry no
 * listed-at time, and the auto-update hold-back must survive restarts so takedowns get time to land.
 */
export class PluginReleaseFirstSeenStore {
  private readonly filePath: string
  private cache: z.infer<typeof firstSeenSchema> | null = null

  constructor(pluginsDataDir: string) {
    this.filePath = join(pluginsDataDir, 'plugin-release-first-seen.json')
  }

  /** The first time `release` was seen for this plugin, recording `now` when it is new. */
  async firstSeen(pluginKey: string, release: string, now: number): Promise<number> {
    const records = await this.read()
    const known = records[pluginKey]
    if (known?.release === release) {
      return known.firstSeenAt
    }
    records[pluginKey] = { release, firstSeenAt: now }
    await mkdir(dirname(this.filePath), { recursive: true })
    await writePluginFileAtomically(this.filePath, `${JSON.stringify(records, null, 2)}\n`)
    return now
  }

  private async read(): Promise<z.infer<typeof firstSeenSchema>> {
    if (!this.cache) {
      const raw = await readFile(this.filePath, 'utf8').catch(() => null)
      const parsed = raw ? firstSeenSchema.safeParse(safeJson(raw)) : null
      // Why reset on damage: a lost record only restarts that release's hold-back.
      this.cache = parsed?.success ? parsed.data : {}
    }
    return this.cache
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
