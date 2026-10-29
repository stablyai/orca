import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writePluginCurrentPointer } from './plugin-current-pointer'
import { readPluginRollbackVersion } from './plugin-rollback-candidate'

const roots: string[] = []

async function pluginDirWith(versions: Record<string, string>, current: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-rollback-'))
  roots.push(root)
  for (const [hash, version] of Object.entries(versions)) {
    await mkdir(join(root, hash), { recursive: true })
    await writeFile(
      join(root, hash, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: 'notes',
        publisher: 'community',
        name: 'Notes',
        version,
        engines: { orca: '>=1.0.0' },
        pluginApi: 1
      })
    )
  }
  await writePluginCurrentPointer(root, current)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('readPluginRollbackVersion', () => {
  const current = 'a'.repeat(64)
  const previous = 'b'.repeat(64)

  it('names the single retained version a rollback restores', async () => {
    const dir = await pluginDirWith({ [current]: '2.0.0', [previous]: '1.4.0' }, current)
    await expect(readPluginRollbackVersion(dir)).resolves.toBe('1.4.0')
  })

  it('offers nothing when no single retained version exists', async () => {
    await expect(
      readPluginRollbackVersion(await pluginDirWith({ [current]: '2.0.0' }, current))
    ).resolves.toBeNull()
    await expect(
      readPluginRollbackVersion(
        await pluginDirWith(
          { [current]: '2.0.0', [previous]: '1.4.0', ['c'.repeat(64)]: '1.3.0' },
          current
        )
      )
    ).resolves.toBeNull()
  })
})
