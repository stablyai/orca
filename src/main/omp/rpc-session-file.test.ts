import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readPiSessionHeader } from '../pi/rpc-launch-resolution'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

it('reads native OMP headers behind their title slot without changing Pi parsing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-session-header-'))
  directories.push(directory)
  const file = join(directory, 'session.jsonl')
  const header = { type: 'session', id: 'native-id', cwd: directory }
  await writeFile(
    file,
    `${JSON.stringify({ type: 'title', v: 1, title: 'Resumed chat' })}\n${JSON.stringify(header)}\n`
  )
  await expect(readPiSessionHeader(file, { titleSlot: true })).resolves.toEqual(header)
  await expect(readPiSessionHeader(file)).rejects.toThrow()
  await writeFile(file, `${JSON.stringify(header)}\n`)
  await expect(readPiSessionHeader(file)).resolves.toEqual(header)
  await rm(file)
  await expect(readPiSessionHeader(file, { titleSlot: true })).resolves.toBeNull()
})
