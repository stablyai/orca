import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listFilesWithReaddir } from './fs-handler-readdir-fallback'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('relay readdir file-list fallback', () => {
  it('returns a bounded prefix instead of rejecting at the requested result limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-readdir-'))
    roots.push(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), 'a')
    await writeFile(join(root, 'src', 'b.ts'), 'b')

    const files = await listFilesWithReaddir(root, [], { maxResults: 1 })

    expect(files).toHaveLength(1)
    expect(['src/a.ts', 'src/b.ts']).toContain(files[0])
  })
})
