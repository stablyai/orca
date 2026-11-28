import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeAll, openAll, readSized } from './peer-mail-file-reads'

let dir: string
const refused = (message: string) => new Error(message)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-peer-mail-reads-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('reads exactly the bytes a file was sized at, and refuses one that grew or shrank since', async () => {
  const [same, grown, shrunk] = ['same.txt', 'grown.txt', 'shrunk.txt'].map((name) => {
    const path = join(dir, name)
    writeFileSync(path, 'twelve bytes')
    return path
  })
  const opened = await openAll([same!, grown!, shrunk!], refused)
  try {
    appendFileSync(grown!, 'x'.repeat(1024 * 1024))
    writeFileSync(shrunk!, 'short')

    expect((await readSized(opened[0]!))?.toString()).toBe('twelve bytes')
    expect(await readSized(opened[1]!)).toBeNull()
    expect(await readSized(opened[2]!)).toBeNull()
  } finally {
    await closeAll(opened)
  }
})

it('refuses a folder before opening anything', async () => {
  await expect(openAll([dir], refused)).rejects.toThrow("can't be read.")
})
