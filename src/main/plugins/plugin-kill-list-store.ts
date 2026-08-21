import { createReadStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pluginKillListSchema, type PluginKillList } from '../../shared/plugins/plugin-kill-list'
import { writePluginFileAtomically } from './plugin-atomic-file-write'

const PLUGIN_KILL_LIST_MAX_BYTES = 4 * 1024 * 1024

export class PluginKillListStore {
  private readonly filePath: string

  constructor(pluginsDataDir: string) {
    this.filePath = join(pluginsDataDir, 'plugin-kill-list.json')
  }

  async read(): Promise<PluginKillList | null> {
    try {
      const chunks: Buffer[] = []
      let totalBytes = 0
      for await (const chunk of createReadStream(this.filePath)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalBytes += bytes.byteLength
        if (totalBytes > PLUGIN_KILL_LIST_MAX_BYTES) {
          throw new Error('plugin kill list exceeds its size limit')
        }
        chunks.push(bytes)
      }
      return pluginKillListSchema.parse(
        JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'))
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw new Error(
        `cached plugin kill list is invalid: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async write(killList: PluginKillList): Promise<void> {
    const parsed = pluginKillListSchema.parse(killList)
    await mkdir(dirname(this.filePath), { recursive: true })
    await writePluginFileAtomically(this.filePath, `${JSON.stringify(parsed, null, 2)}\n`)
  }
}
