import type * as FileSystem from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishAgentImage } from './agent-image-publication'

const publication = vi.hoisted((): { controller: AbortController | null } => ({ controller: null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args)
      publication.controller?.abort()
    }
  }
})
const roots: string[] = []
afterEach(async () => {
  publication.controller = null
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([10, 100])(
  'reclaims staging from %i cancelled publications and preserves a successor',
  async (count) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-image-publication-'))
    roots.push(root)
    const path = join(root, 'view.png')
    for (let attempt = 0; attempt < count; attempt += 1) {
      const controller = new AbortController()
      publication.controller = controller
      await expect(
        publishAgentImage({ path, bytes: new Uint8Array([1, 2, 3]) }, controller.signal)
      ).rejects.toThrow()
    }
    expect(await readdir(root)).toEqual([])
    publication.controller = null
    expect(await publishAgentImage({ path, bytes: new Uint8Array([4, 5, 6]) })).toBe(path)
    expect([...(await readFile(path))]).toEqual([4, 5, 6])
    expect(await readdir(root)).toEqual(['view.png'])
  }
)
