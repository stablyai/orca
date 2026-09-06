import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from './providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider } from './providers/types'
import { detectRepoIcon, detectRepoIconAndUpstream } from './repo-icon-autodetect'

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

const tempDirs: string[] = []

async function makeTempRepoDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-repo-icon-'))
  tempDirs.push(dir)
  return dir
}

const registeredHosts: string[] = []

/** A remote host whose only readable file is a package.json naming a host-specific homepage. */
function registerHomepageHost(connectionId: string, homepage: string) {
  const stat = vi.fn(async (filePath: string) => {
    if (!filePath.endsWith('/package.json')) {
      throw new Error('ENOENT')
    }
    return { type: 'file', size: 64, mtime: 0 }
  })
  const readFile = vi.fn(async () => ({
    content: JSON.stringify({ homepage }),
    isBinary: false,
    mimeType: 'application/json'
  }))
  registerSshFilesystemProvider(connectionId, { stat, readFile } as unknown as IFilesystemProvider)
  registeredHosts.push(connectionId)
  return { stat, readFile }
}

afterEach(async () => {
  for (const connectionId of registeredHosts.splice(0)) {
    unregisterSshFilesystemProvider(connectionId)
  }
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

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'local' })
    ).resolves.toEqual({
      type: 'image',
      src: `data:image/png;base64,${PNG_1X1_BASE64}`,
      source: 'file',
      label: 'favicon.png'
    })
  })

  it('detects Tauri bundle icons under src-tauri/icons', async () => {
    const repoPath = await makeTempRepoDir()
    await mkdir(join(repoPath, 'src-tauri', 'icons'), { recursive: true })
    await writeFile(
      join(repoPath, 'src-tauri', 'icons', 'icon.png'),
      Buffer.from(PNG_1X1_BASE64, 'base64')
    )

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'local' })
    ).resolves.toEqual({
      type: 'image',
      src: `data:image/png;base64,${PNG_1X1_BASE64}`,
      source: 'file',
      label: 'src-tauri/icons/icon.png'
    })
  })

  it('detects public WebP icons used by CLI tools', async () => {
    const repoPath = await makeTempRepoDir()
    const webpBase64 = 'UklGRhoAAABXRUJQVlA4IA4AAAAwAQCdASoBAAEAAQIlSkwAAA=='
    await mkdir(join(repoPath, 'public'), { recursive: true })
    await writeFile(join(repoPath, 'public', 'icon.webp'), Buffer.from(webpBase64, 'base64'))

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'local' })
    ).resolves.toEqual({
      type: 'image',
      src: `data:image/webp;base64,${webpBase64}`,
      source: 'file',
      label: 'public/icon.webp'
    })
  })

  it('uses a package homepage favicon when no local icon file exists', async () => {
    const repoPath = await makeTempRepoDir()
    await writeFile(
      join(repoPath, 'package.json'),
      JSON.stringify({ homepage: 'https://app.example.com/docs' })
    )

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'local' })
    ).resolves.toEqual({
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

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'local' })
    ).resolves.toEqual({
      type: 'image',
      src: `data:image/png;base64,${PNG_1X1_BASE64}`,
      source: 'file',
      label: 'public/brand/icon.png'
    })
  })

  it('resolves relative declared icon hrefs from nested source files', async () => {
    const repoPath = await makeTempRepoDir()
    await mkdir(join(repoPath, 'src', 'routes', 'brand'), { recursive: true })
    await writeFile(
      join(repoPath, 'src', 'routes', '__root.tsx'),
      'export const links = () => [{ rel: "icon", href: "./brand/icon.png" }]'
    )
    await writeFile(
      join(repoPath, 'src', 'routes', 'brand', 'icon.png'),
      Buffer.from(PNG_1X1_BASE64, 'base64')
    )

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'local' })
    ).resolves.toEqual({
      type: 'image',
      src: `data:image/png;base64,${PNG_1X1_BASE64}`,
      source: 'file',
      label: 'src/routes/brand/icon.png'
    })
  })

  it('skips oversized source files when looking for declared icon hrefs', async () => {
    const repoPath = await makeTempRepoDir()
    await writeFile(
      join(repoPath, 'index.html'),
      `${'x'.repeat(256 * 1024 + 1)}<link rel="icon" href="/brand/icon.png">`
    )
    await mkdir(join(repoPath, 'public', 'brand'), { recursive: true })
    await writeFile(
      join(repoPath, 'public', 'brand', 'icon.png'),
      Buffer.from(PNG_1X1_BASE64, 'base64')
    )

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'local' })
    ).resolves.toBeUndefined()
  })

  it('does not resolve declared icon hrefs outside the repo', async () => {
    const parentPath = await makeTempRepoDir()
    const repoPath = join(parentPath, 'repo')
    await mkdir(repoPath)
    await writeFile(join(parentPath, 'outside.png'), Buffer.from(PNG_1X1_BASE64, 'base64'))
    await writeFile(join(repoPath, 'index.html'), '<link rel="icon" href="../outside.png">')

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'local' })
    ).resolves.toBeUndefined()
  })

  it('returns no icon for an SSH-hosted repo whose filesystem provider is missing', async () => {
    // Why: the same path exists on the client machine — reading it would hand
    // back the local repository's icon for a remote repo.
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

  it('still detects local icons for a repo on this machine', async () => {
    const repoPath = await makeTempRepoDir()
    await writeFile(join(repoPath, 'favicon.png'), Buffer.from(PNG_1X1_BASE64, 'base64'))

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'local' })
    ).resolves.toMatchObject({ source: 'file', label: 'favicon.png' })
  })

  it('routes each SSH host to its own filesystem provider', async () => {
    const repoPath = await makeTempRepoDir()
    // On disk on this machine, so a host-blind probe would answer with this one for both hosts.
    await writeFile(join(repoPath, 'favicon.png'), Buffer.from(PNG_1X1_BASE64, 'base64'))
    registerHomepageHost('m4air', 'https://m4air.example.com')
    registerHomepageHost('openclaw', 'https://openclaw.example.com')

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'ssh:m4air' })
    ).resolves.toMatchObject({
      source: 'favicon',
      src: expect.stringContaining('m4air.example.com')
    })
    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'ssh:openclaw' })
    ).resolves.toMatchObject({
      source: 'favicon',
      src: expect.stringContaining('openclaw.example.com')
    })
  })

  it('reads nothing for a runtime host even when its nested SSH target is registered here', async () => {
    // Why: a `runtime:` repo row's `connectionId` names a target in that server's namespace. Both
    // spellings of the incumbent shape are wrong here — a null one reads this machine's copy of
    // the path, and the nested id dials a same-named box of ours.
    const repoPath = await makeTempRepoDir()
    await writeFile(join(repoPath, 'favicon.png'), Buffer.from(PNG_1X1_BASE64, 'base64'))
    const nested = registerHomepageHost('nested-1', 'https://nested.example.com')

    await expect(
      detectRepoIcon({ repoPath, kind: 'folder', executionHostId: 'runtime:env-a' })
    ).resolves.toBeUndefined()
    expect(nested.stat).not.toHaveBeenCalled()
  })

  it('falls back to the GitHub owner avatar for GitHub repos', async () => {
    const repoPath = await makeTempRepoDir()
    await gitExecFileAsync(['init'], { cwd: repoPath })
    await gitExecFileAsync(['remote', 'add', 'origin', 'git@github.com:stablyai/orca.git'], {
      cwd: repoPath
    })

    await expect(
      detectRepoIcon({ repoPath, kind: 'git', executionHostId: 'local' })
    ).resolves.toEqual({
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

    await expect(
      detectRepoIcon({ repoPath, kind: 'git', executionHostId: 'local' })
    ).resolves.toEqual({
      type: 'image',
      src: 'https://github.com/stablyai.png?size=64',
      source: 'github',
      label: 'stablyai/orca'
    })
  })

  it('stores a null upstream marker for git repos without a resolved fork parent', async () => {
    const repoPath = await makeTempRepoDir()
    await gitExecFileAsync(['init'], { cwd: repoPath })

    await expect(
      detectRepoIconAndUpstream({ repoPath, kind: 'git', executionHostId: 'local' })
    ).resolves.toEqual({
      upstream: null
    })
  })

  it('uses the resolved fork upstream for both metadata and the GitHub avatar', async () => {
    const repoPath = await makeTempRepoDir()
    await gitExecFileAsync(['init'], { cwd: repoPath })
    await gitExecFileAsync(['remote', 'add', 'origin', 'git@github.com:tmchow/orca.git'], {
      cwd: repoPath
    })
    await gitExecFileAsync(['remote', 'add', 'upstream', 'git@github.com:stablyai/orca.git'], {
      cwd: repoPath
    })

    await expect(
      detectRepoIconAndUpstream({ repoPath, kind: 'git', executionHostId: 'local' })
    ).resolves.toEqual({
      gitRemoteIdentity: {
        canonicalKey: 'github.com/stablyai/orca',
        remoteName: 'upstream',
        remoteUrl: 'git@github.com:stablyai/orca.git'
      },
      repoIcon: {
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      },
      // Why: fork parents resolve host-qualified so avatars/links stay on the fork's server.
      upstream: { owner: 'stablyai', repo: 'orca', host: 'github.com' }
    })
  })

  it('keeps the renamed fork own owner avatar while storing the upstream metadata', async () => {
    const repoPath = await makeTempRepoDir()
    await gitExecFileAsync(['init'], { cwd: repoPath })
    await gitExecFileAsync(['remote', 'add', 'origin', 'git@github.com:acme/rocket-pro.git'], {
      cwd: repoPath
    })
    await gitExecFileAsync(
      ['remote', 'add', 'upstream', 'git@github.com:upstream-org/rocket.git'],
      {
        cwd: repoPath
      }
    )

    await expect(
      detectRepoIconAndUpstream({ repoPath, kind: 'git', executionHostId: 'local' })
    ).resolves.toEqual({
      gitRemoteIdentity: {
        canonicalKey: 'github.com/upstream-org/rocket',
        remoteName: 'upstream',
        remoteUrl: 'git@github.com:upstream-org/rocket.git'
      },
      // Why: a renamed fork is its own project, so the avatar stays on the origin owner.
      repoIcon: {
        type: 'image',
        src: 'https://github.com/acme.png?size=64',
        source: 'github',
        label: 'acme/rocket-pro'
      },
      upstream: { owner: 'upstream-org', repo: 'rocket', host: 'github.com' }
    })
  })

  it('detects a provider-neutral git remote identity for non-GitHub remotes', async () => {
    const repoPath = await makeTempRepoDir()
    await gitExecFileAsync(['init'], { cwd: repoPath })
    await gitExecFileAsync(
      ['remote', 'add', 'origin', 'git@git.company.test:platform/tools/sample-app.git'],
      { cwd: repoPath }
    )

    await expect(
      detectRepoIconAndUpstream({ repoPath, kind: 'git', executionHostId: 'local' })
    ).resolves.toMatchObject({
      gitRemoteIdentity: {
        canonicalKey: 'git.company.test/platform/tools/sample-app',
        remoteName: 'origin',
        remoteUrl: 'git@git.company.test:platform/tools/sample-app.git'
      },
      upstream: null
    })
  })
})
