import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { detectRepoIcon } from './repo-icon-autodetect'

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

const tempDirs: string[] = []

async function makeTempRepoDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-repo-icon-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('detectRepoIcon', () => {
  it('returns no icon for an SSH-hosted repo whose filesystem provider is missing', async () => {
    // A real local icon at this path exposes accidental fallback reads.
    const repoPath = await makeTempRepoDir()
    await writeFile(join(repoPath, 'favicon.png'), Buffer.from(PNG_1X1_BASE64, 'base64'))
    await writeFile(
      join(repoPath, 'package.json'),
      JSON.stringify({ homepage: 'https://app.example.com/docs' })
    )

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'ssh:not-connected' })
    ).resolves.toBeUndefined()
  })
})
