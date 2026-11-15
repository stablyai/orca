import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { themeStudioDraftSchema } from '../../shared/theme-studio/theme-studio-draft'
import type { ThemeStudioSavedTheme } from '../../shared/theme-studio/theme-studio-protocol'

const MAX_SAVED = 256

const savedEntrySchema = z.object({
  pluginKey: z.string().max(256),
  id: z.string().max(64),
  name: z.string().max(64),
  by: z.string().max(256).optional(),
  savedAt: z.number(),
  /** The theme as saved, so rename and duplicate rewrite it without reading plugin files. */
  draft: themeStudioDraftSchema,
  /** The slots the save replaced, while this run of Orca still holds them. */
  restorePoint: z.string().max(64).optional()
})
export type ThemeStudioSavedEntry = z.infer<typeof savedEntrySchema>

const savedFileSchema = z.object({
  version: z.literal(1),
  themes: z.array(savedEntrySchema).max(MAX_SAVED)
})

/** The themes `orca theme` saved as local plugins: what Settings marks as custom. */
export class ThemeStudioSavedThemes {
  private entries: ThemeStudioSavedEntry[] = []
  private writing: Promise<void> = Promise.resolve()
  readonly ready: Promise<void>

  constructor(
    private readonly file: string,
    private readonly changed: (themes: ThemeStudioSavedTheme[]) => void
  ) {
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    try {
      this.entries = savedFileSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))).themes
    } catch {
      this.entries = []
    }
  }

  list(): ThemeStudioSavedTheme[] {
    return this.entries.map(({ pluginKey, name, by, savedAt }) => ({
      pluginKey,
      name,
      ...(by ? { by } : {}),
      savedAt
    }))
  }

  find(pluginKey: string): ThemeStudioSavedEntry | undefined {
    return this.entries.find((entry) => entry.pluginKey === pluginKey)
  }

  /** Adds or replaces the entry for its plugin key. */
  record(entry: ThemeStudioSavedEntry): void {
    this.entries = [
      ...this.entries.filter((other) => other.pluginKey !== entry.pluginKey),
      entry
    ].slice(-MAX_SAVED)
    this.persist()
  }

  remove(pluginKey: string): void {
    this.entries = this.entries.filter((entry) => entry.pluginKey !== pluginKey)
    this.persist()
  }

  private persist(): void {
    this.changed(this.list())
    const body = JSON.stringify({ version: 1, themes: this.entries })
    // Why chained: two quick changes must not share the temporary file.
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(`${this.file}.tmp`, body, 'utf8')
        await rename(`${this.file}.tmp`, this.file)
      } catch (error) {
        console.warn('[theme-studio] could not save the theme list:', error)
      }
    })
  }
}
