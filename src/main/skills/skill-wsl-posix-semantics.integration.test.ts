import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  computeSkillPackageDigest,
  parseSkillPackageManifest,
  type SkillPackageFile
} from '../../shared/skill-package-manifest'
import { installSharedSkill } from './skill-install-service'
import { createSkillBundleArchive } from './skill-bundle-creation'
import { installSkillBundle } from './skill-bundle-install-service'
import { writeSkillTarGzip } from './skill-package-tar'
import { detectSkillProvidersInWsl } from './skill-wsl-provider-detection'
import { createWslSkillInstallFilesystem } from './skill-wsl-install-filesystem'

const execFileAsync = promisify(execFile)
const DISTRO = process.env.ORCA_REAL_WSL_SKILL_DISTRO ?? 'Ubuntu-24.04'
const RUN_REAL_WSL = process.platform === 'win32' && process.env.ORCA_REAL_WSL_SKILL_TEST === '1'

async function runWsl(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('wsl.exe', ['-d', DISTRO, '--exec', ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true
  })
  return stdout.trim()
}

function uncPath(guestPath: string): string {
  return `\\\\wsl.localhost\\${DISTRO}${guestPath.replaceAll('/', '\\')}`
}

function packageFile(path: string, bytes: Buffer, executable: boolean): SkillPackageFile {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    path,
    size: bytes.length,
    executable,
    classification: 'text',
    sha256,
    identitySha256: sha256
  }
}

describe.runIf(RUN_REAL_WSL)('real WSL POSIX skill semantics', () => {
  let localRoot = ''
  let guestRoot = ''

  beforeAll(async () => {
    localRoot = await mkdtemp(join(tmpdir(), 'orca-wsl-posix-semantics-'))
    guestRoot = await runWsl('mktemp', '-d', '/tmp/orca-skill-posix.XXXXXX')
    if (!guestRoot.startsWith('/tmp/orca-skill-posix.')) {
      throw new Error('unexpected-wsl-posix-root')
    }
    await runWsl('mkdir', '-p', `${guestRoot}/home`)
  })

  afterAll(async () => {
    await rm(localRoot, { recursive: true, force: true })
    if (guestRoot.startsWith('/tmp/orca-skill-posix.')) {
      await runWsl('rm', '-rf', '--', guestRoot)
    }
  })

  it('detects providers from the selected distro', async () => {
    await expect(detectSkillProvidersInWsl(DISTRO)).resolves.toContain('codex')
  })

  it('preserves case and applies owner-private executable modes', async () => {
    const markdown = Buffer.from(
      '---\nname: wsl-mode-skill\ndescription: WSL modes\n---\n\n# WSL\n'
    )
    const script = Buffer.from('#!/bin/sh\nprintf ok\n')
    const files = [
      packageFile('SKILL.md', markdown, false),
      packageFile('scripts/run.sh', script, true)
    ]
    const manifest = parseSkillPackageManifest({
      schemaVersion: 1,
      packageId: 'package-wsl-mode',
      versionId: 'version-wsl-mode',
      name: 'wsl-mode-skill',
      description: 'WSL modes',
      createdAt: '2026-08-11T00:00:00.000Z',
      files,
      packageDigest: computeSkillPackageDigest(files)
    })
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    const archivePath = join(localRoot, 'package.tar.gz')
    const archive = await writeSkillTarGzip(archivePath, [
      {
        path: 'manifest.json',
        size: manifestBytes.length,
        executable: false,
        bytes: manifestBytes
      },
      { path: 'skill/SKILL.md', size: markdown.length, executable: false, bytes: markdown },
      { path: 'skill/scripts/run.sh', size: script.length, executable: true, bytes: script }
    ])
    const homeDirectory = uncPath(`${guestRoot}/home`)
    const filesystem = createWslSkillInstallFilesystem({ distro: DISTRO, homeDirectory })

    const result = await installSharedSkill({
      operationId: 'wsl-posix-semantics',
      archivePath,
      scope: 'global',
      homeDirectory,
      orcaStateDirectory: join(localRoot, 'state'),
      detectedProviders: [],
      destinationIdentity: 'global:wsl-posix',
      hostIdentity: 'windows-2',
      expectedArchiveSha256: archive.archiveSha256,
      expectedPackageDigest: manifest.packageDigest,
      filesystem,
      wslDistro: DISTRO
    })
    expect(result.status, JSON.stringify(result)).toBe('installed')

    const skill = `${guestRoot}/home/.agents/skills/wsl-mode-skill`
    await expect(runWsl('stat', '-c', '%a', `${skill}/SKILL.md`)).resolves.toBe('600')
    await expect(runWsl('stat', '-c', '%a', `${skill}/scripts/run.sh`)).resolves.toBe('700')
    await expect(runWsl('test', '!', '-e', `${skill}/skill.md`)).resolves.toBe('')
    await expect(runWsl(`${skill}/scripts/run.sh`)).resolves.toBe('ok')
  })

  it('installs only selected bundle skills into the distro-owned home', async () => {
    const sources = join(localRoot, 'bundle-sources')
    const alpha = join(sources, 'wsl-alpha')
    const beta = join(sources, 'wsl-beta')
    await Promise.all([mkdir(alpha, { recursive: true }), mkdir(beta, { recursive: true })])
    await writeFile(
      join(alpha, 'SKILL.md'),
      '---\nname: wsl-alpha\ndescription: WSL alpha\n---\n\n# Alpha\n'
    )
    await writeFile(
      join(beta, 'SKILL.md'),
      '---\nname: wsl-beta\ndescription: WSL beta\n---\n\n# Beta\n'
    )
    const bundle = await createSkillBundleArchive({
      sources: [{ sourceDirectory: alpha }, { sourceDirectory: beta }],
      archivePath: join(localRoot, 'wsl-bundle.tar.gz'),
      packageId: 'package-wsl-bundle',
      versionId: 'version-wsl-bundle',
      bundleName: 'wsl-bundle'
    })
    const homeDirectory = uncPath(`${guestRoot}/home`)
    const filesystem = createWslSkillInstallFilesystem({ distro: DISTRO, homeDirectory })

    const result = await installSkillBundle({
      operationId: 'wsl-bundle-install',
      archivePath: bundle.archivePath,
      packageId: bundle.manifest.packageId,
      versionId: bundle.manifest.versionId,
      bundleDigest: bundle.manifest.bundleDigest,
      selectedSkillIds: ['wsl-alpha'],
      expectedArchiveSha256: bundle.archiveSha256,
      scope: 'global',
      homeDirectory,
      orcaStateDirectory: join(localRoot, 'bundle-state'),
      detectedProviders: [],
      destinationIdentity: 'global:wsl-bundle',
      hostIdentity: 'windows-2',
      filesystem,
      wslDistro: DISTRO
    })

    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'complete',
      skills: [{ name: 'wsl-alpha' }]
    })
    await expect(
      runWsl('test', '-f', `${guestRoot}/home/.agents/skills/wsl-alpha/SKILL.md`)
    ).resolves.toBe('')
    await expect(
      runWsl('test', '!', '-e', `${guestRoot}/home/.agents/skills/wsl-beta`)
    ).resolves.toBe('')
  })
})
