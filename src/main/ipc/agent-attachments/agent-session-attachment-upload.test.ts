import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { uploadExternalPaths } from './agent-session-attachment-upload'

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orca-attachment-upload-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('uploadExternalPaths with a total for the drop', () => {
  it('refuses the files that would take one drop past its total and keeps sending the rest', async () => {
    await writeFile(join(workDir, 'a.txt'), '123456')
    await writeFile(join(workDir, 'b.txt'), '123456')
    await writeFile(join(workDir, 'c.txt'), '1234')
    const stored: string[] = []
    const result = await uploadExternalPaths(
      ['a.txt', 'b.txt', 'c.txt'].map((name) => join(workDir, name)),
      {
        maxBytes: 100,
        label: 'test limit',
        total: { maxBytes: 10, reason: (name) => `${name} is past the total` }
      },
      async (file, writeBody) => {
        await writeBody(async () => {})
        stored.push(file.name)
        return `/server/${file.name}`
      }
    )
    expect(stored).toEqual(['a.txt', 'c.txt'])
    expect(result.failed).toEqual([
      { sourcePath: join(workDir, 'b.txt'), reason: 'b.txt is past the total' }
    ])
  })
})
