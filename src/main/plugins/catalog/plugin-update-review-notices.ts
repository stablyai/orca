import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { splitQualifiedPluginKey } from '../../../shared/plugins/catalog/plugin-marketplace'
import type {
  PluginUpdateHold,
  PluginUpdateReviewNotice
} from '../../../shared/plugins/catalog/plugin-update-policy'
import { writePluginFileAtomically } from '../installation/plugin-atomic-file-write'

const notifiedSchema = z.record(z.string().max(256), z.string().max(256))

type PluginUpdateReviewNoticesOptions = {
  pluginsDataDir: string
  /** The auto-updater's current holds; re-read on every take so a resolved hold is never told. */
  getHeld: () => Readonly<Record<string, PluginUpdateHold>>
  /** Installed name for the toast; null drops the notice (plugin gone since the pass). */
  findName: (pluginKey: string) => string | null
  isKillListed: (pluginKey: string) => boolean
}

/**
 * Tells the user once per plugin version that an automatic update is waiting for their review.
 * Why persisted: a restart or reopened window must not repeat a version already told; a newer
 * version is told again. Why taken by the renderer: a pass can finish while no window is open.
 */
export class PluginUpdateReviewNotices {
  private readonly filePath: string
  private notified: Record<string, string> | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: PluginUpdateReviewNoticesOptions) {
    this.filePath = join(options.pluginsDataDir, 'plugin-update-review-notified.json')
  }

  /** Holds not yet told, marked told as they are returned; concurrent windows never both get one. */
  take(): Promise<PluginUpdateReviewNotice[]> {
    const next = this.queue.then(() => this.takeNow())
    this.queue = next.catch(() => undefined)
    return next
  }

  private async takeNow(): Promise<PluginUpdateReviewNotice[]> {
    const notified = await this.read()
    const notices: PluginUpdateReviewNotice[] = []
    for (const [pluginKey, hold] of Object.entries(this.options.getHeld())) {
      if (notified[pluginKey] === hold.version || this.options.isKillListed(pluginKey)) {
        continue
      }
      const publisher = splitQualifiedPluginKey(pluginKey)?.publisher
      const name = this.options.findName(pluginKey)
      if (!publisher || !name) {
        continue
      }
      notices.push({ ...hold, pluginKey, name, publisher })
    }
    if (notices.length === 0) {
      return notices
    }
    const next = { ...notified }
    for (const notice of notices) {
      next[notice.pluginKey] = notice.version
    }
    this.notified = next
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writePluginFileAtomically(this.filePath, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      // Why still return: the cache keeps this session quiet; at worst a restart tells once more.
      console.warn('[plugins] failed to record update review notices:', error)
    }
    return notices
  }

  private async read(): Promise<Record<string, string>> {
    if (!this.notified) {
      const raw = await readFile(this.filePath, 'utf8').catch(() => null)
      const parsed = raw ? notifiedSchema.safeParse(safeJson(raw)) : null
      // Why reset on damage: a lost record only repeats a notice, it never hides one.
      this.notified = parsed?.success ? parsed.data : {}
    }
    return this.notified
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
