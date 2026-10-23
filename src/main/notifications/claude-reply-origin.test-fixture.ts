import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function createReplyTranscriptFixture() {
  const directories: string[] = []
  return {
    async transcript(rows: unknown[]): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'reply-origin-'))
      directories.push(dir)
      const path = join(dir, 'invented.jsonl')
      await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
      return path
    },
    async dispose(): Promise<void> {
      await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
      )
    }
  }
}
