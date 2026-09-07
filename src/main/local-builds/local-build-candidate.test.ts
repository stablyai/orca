import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import type { LocalBuildCompatibility } from '../../shared/local-build-compatibility'
import { loadLocalBuildCandidate } from './local-build-candidate'
import { startLocalBuildFeed } from './local-build-feed-server'

const tempDirectories: string[] = []
const execFileAsync = promisify(execFile)

function compatibility(): LocalBuildCompatibility {
  return {
    formatVersion: 1,
    appId: 'com.stablyai.orca',
    buildId: '1.2.3-local.1-abc-arm64',
    version: '1.2.3-local.1',
    commit: 'abc',
    stateSchemaVersion: 1,
    readableStateSchemaVersions: [1],
    daemonProtocolVersion: 28,
    attachableDaemonProtocolVersions: [28],
    platform: 'darwin',
    architecture: 'arm64'
  }
}

async function fixture(options: { sha512?: string; url?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-local-build-'))
  tempDirectories.push(directory)
  const artifactName = 'orca-macos-arm64.zip'
  const artifactPath = join(directory, artifactName)
  const content = Buffer.from('signed-zip-placeholder')
  await writeFile(artifactPath, content)
  const manifestPath = join(directory, 'latest-mac.yml')
  await writeFile(
    manifestPath,
    stringify({
      version: compatibility().version,
      files: [
        {
          url: options.url ?? artifactName,
          sha512: options.sha512 ?? createHash('sha512').update(content).digest('base64'),
          size: content.length
        },
        {
          url: 'orca-macos-arm64.dmg',
          sha512: Buffer.alloc(64).toString('base64'),
          size: 1
        }
      ]
    })
  )
  return { artifactPath, directory, manifestPath }
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('loadLocalBuildCandidate', () => {
  it('returns a sanitized, architecture-specific feed after hash validation', async () => {
    const { manifestPath } = await fixture()
    const candidate = await loadLocalBuildCandidate(manifestPath, 'arm64', {
      readCompatibility: async () => compatibility()
    })

    expect(candidate.version).toBe('1.2.3-local.1')
    expect([...candidate.artifacts.keys()]).toEqual(['orca-macos-arm64.zip'])
    expect(candidate.manifestContent).toContain('orca-macos-arm64.zip')
    await candidate.close()
  })

  it('rejects mismatched hashes and traversal paths', async () => {
    const badHash = await fixture({ sha512: Buffer.alloc(64).toString('base64') })
    await expect(
      loadLocalBuildCandidate(badHash.manifestPath, 'arm64', {
        readCompatibility: async () => compatibility()
      })
    ).rejects.toThrow('SHA-512 verification failed')

    const traversal = await fixture({ url: '../orca-macos-arm64.zip' })
    await expect(
      loadLocalBuildCandidate(traversal.manifestPath, 'arm64', {
        readCompatibility: async () => compatibility()
      })
    ).rejects.toThrow('invalid file entry')
  })

  it('rejects symlinked artifacts', async () => {
    const { artifactPath, directory, manifestPath } = await fixture()
    const realArtifact = join(directory, 'real.zip')
    await writeFile(realArtifact, 'signed-zip-placeholder')
    await rm(artifactPath)
    await symlink(realArtifact, artifactPath)

    await expect(
      loadLocalBuildCandidate(manifestPath, 'arm64', {
        readCompatibility: async () => compatibility()
      })
    ).rejects.toThrow('regular files, not links')
  })

  it('serves the same artifact descriptor that passed validation', async () => {
    const { artifactPath, directory, manifestPath } = await fixture()
    const movedArtifactPath = join(directory, 'validated.zip')
    const candidate = await loadLocalBuildCandidate(manifestPath, 'arm64', {
      readCompatibility: async () => {
        await rename(artifactPath, movedArtifactPath)
        await writeFile(artifactPath, 'replacement')
        return compatibility()
      }
    })
    const feed = await startLocalBuildFeed(candidate)
    try {
      await expect(
        fetch(`${feed.url}orca-macos-arm64.zip`).then((response) => response.text())
      ).resolves.toBe('signed-zip-placeholder')
    } finally {
      await feed.close()
    }
  })

  it.runIf(process.platform === 'darwin')(
    'reads signed compatibility metadata through the held artifact descriptor',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'orca-local-build-zip-'))
      tempDirectories.push(directory)
      const zipRoot = join(directory, 'zip-root')
      const resources = join(zipRoot, 'Orca.app', 'Contents', 'Resources')
      await mkdir(resources, { recursive: true })
      await writeFile(join(resources, 'orca-local-build.json'), JSON.stringify(compatibility()))
      const artifactName = 'orca-macos-arm64.zip'
      const artifactPath = join(directory, artifactName)
      await execFileAsync('/usr/bin/zip', ['-qry', artifactPath, 'Orca.app'], { cwd: zipRoot })
      const artifact = await readFile(artifactPath)
      const manifestPath = join(directory, 'latest-mac.yml')
      await writeFile(
        manifestPath,
        stringify({
          version: compatibility().version,
          files: [
            {
              url: artifactName,
              sha512: createHash('sha512').update(artifact).digest('base64'),
              size: artifact.length
            }
          ]
        })
      )

      const candidate = await loadLocalBuildCandidate(manifestPath, 'arm64')
      expect(candidate.compatibility).toEqual(compatibility())
      await candidate.close()
    }
  )

  it('requires exactly one ZIP for the running architecture', async () => {
    const { manifestPath } = await fixture()
    await expect(
      loadLocalBuildCandidate(manifestPath, 'x64', {
        readCompatibility: async () => compatibility()
      })
    ).rejects.toThrow('exactly one x64 Orca ZIP')
  })
})
