import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeCommunityJson } from './community-json-file'
export class CommunityEvidenceStore {
  constructor(private readonly root: string) {}
  async save(value: unknown): Promise<string> {
    const bytes = JSON.stringify(value)
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) {
      throw new Error('This evidence capture exceeds the size limit.')
    }
    const id = createHash('sha256').update(bytes).digest('hex')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeCommunityJson(join(this.root, `${id}.json`), value)
    return id
  }
  async read(id: string): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error('Invalid evidence identifier.')
    }
    const bytes = await readFile(join(this.root, `${id}.json`))
    if (bytes.length > 4 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== id) {
      throw new Error('The evidence file failed its integrity check.')
    }
    return JSON.parse(bytes.toString('utf8'))
  }
}
