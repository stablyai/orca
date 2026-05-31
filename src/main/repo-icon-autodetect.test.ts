import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from './git/runner'
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
  it('uses a small repo-local favicon PNG first', async () => {
    const repoPath = await makeTempRepoDir()
    await writeFile(join(repoPath, 'favicon.png'), Buffer.from(PNG_1X1_BASE64, 'base64'))
    await writeFile(
      join(repoPath, 'package.json'),
      JSON.stringify({ homepage: 'https://example.com' })
    )

    await expect(detectRepoIcon({ repoPath, kind: 'folder' })).resolves.toEqual({
      type: 'image',
      src: `data:image/png;base64,${PNG_1X1_BASE64}`,
      source: 'file',
      label: 'favicon.png'
    })
  })

  it('uses a package homepage favicon when no local icon file exists', async () => {
    const repoPath = await makeTempRepoDir()
    await writeFile(
      join(repoPath, 'package.json'),
      JSON.stringify({ homepage: 'https://app.example.com/docs' })
    )

    await expect(detectRepoIcon({ repoPath, kind: 'folder' })).resolves.toEqual({
      type: 'image',
      src: 'https://www.google.com/s2/favicons?domain=app.example.com&sz=64',
      source: 'favicon',
      label: 'Website favicon'
    })
  })

  it('resolves declared icon hrefs from project source files', async () => {
    const repoPath = await makeTempRepoDir()
    await writeFile(join(repoPath, 'index.html'), '<link rel="icon" href="/brand/icon.png">')
    await mkdir(join(repoPath, 'public', 'brand'), { recursive: true })
    await writeFile(
      join(repoPath, 'public', 'brand', 'icon.png'),
      Buffer.from(PNG_1X1_BASE64, 'base64')
    )

    await expect(detectRepoIcon({ repoPath, kind: 'folder' })).resolves.toEqual({
      type: 'image',
      src: `data:image/png;base64,${PNG_1X1_BASE64}`,
      source: 'file',
      label: 'public/brand/icon.png'
    })
  })

  it('does not resolve declared icon hrefs outside the repo', async () => {
    const parentPath = await makeTempRepoDir()
    const repoPath = join(parentPath, 'repo')
    await mkdir(repoPath)
    await writeFile(join(parentPath, 'outside.png'), Buffer.from(PNG_1X1_BASE64, 'base64'))
    await writeFile(join(repoPath, 'index.html'), '<link rel="icon" href="../outside.png">')

    await expect(detectRepoIcon({ repoPath, kind: 'folder' })).resolves.toBeUndefined()
  })

  it('falls back to the GitHub owner avatar for GitHub repos', async () => {
    const repoPath = await makeTempRepoDir()
    await gitExecFileAsync(['init'], { cwd: repoPath })
    await gitExecFileAsync(['remote', 'add', 'origin', 'git@github.com:stablyai/orca.git'], {
      cwd: repoPath
    })

    await expect(detectRepoIcon({ repoPath, kind: 'git' })).resolves.toEqual({
      type: 'image',
      src: 'https://github.com/stablyai.png?size=64',
      source: 'github',
      label: 'stablyai/orca'
    })
  })

  it('skips code-host package homepages so GitHub remotes stay repo-specific', async () => {
    const repoPath = await makeTempRepoDir()
    await writeFile(
      join(repoPath, 'package.json'),
      JSON.stringify({ homepage: 'https://github.com/stablyai/orca' })
    )
    await gitExecFileAsync(['init'], { cwd: repoPath })
    await gitExecFileAsync(['remote', 'add', 'origin', 'https://github.com/stablyai/orca.git'], {
      cwd: repoPath
    })

    await expect(detectRepoIcon({ repoPath, kind: 'git' })).resolves.toEqual({
      type: 'image',
      src: 'https://github.com/stablyai.png?size=64',
      source: 'github',
      label: 'stablyai/orca'
    })
  })
})
