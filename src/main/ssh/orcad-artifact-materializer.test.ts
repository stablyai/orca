import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_EMOJI_SHORTCODE_DATASET,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  ORCAD_VERSION_FILENAME,
  orcadArtifactFilenames
} from '../../shared/orcad-artifacts'
import type { OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import { assembleOrcadArtifact } from './orcad-artifact-materializer'

const TARGET = 'linux-x64-glibc' as const
const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function createTemplate(target: OrcadBunTarget = TARGET): {
  root: string
  templateDir: string
  cacheRoot: string
  runtimePath: string
} {
  const root = mkdtempSync(join(tmpdir(), 'orcad-artifact-template-'))
  temporaryDirs.push(root)
  const templateDir = join(root, 'template')
  const cacheRoot = join(root, 'cache')
  const runtimePath = join(root, 'bun-runtime')
  const common: Record<string, string> = {
    'orcad.js': 'orcad-entry',
    'daemon-entry.js': 'daemon-entry',
    'windows-bun-pty-gate-entry.js': 'pty-gate-entry',
    'parcel-watcher-process-entry.js': 'watcher-process',
    'node_modules/@parcel/watcher/index.js': 'watcher-wrapper',
    [ORCAD_EMOJI_SHORTCODE_DATASET]: '{}'
  }
  for (const [filename, contents] of Object.entries(common)) {
    write(join(templateDir, filename), contents)
  }
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  write(join(targetDir, ORCAD_BUILD_TARGET_FILENAME), `${target}\n`)
  write(join(targetDir, 'watcher.node'), 'native-watcher')
  write(join(targetDir, 'agent-browser-linux-x64'), 'browser')
  write(runtimePath, 'bun-executable')
  write(
    join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME),
    JSON.stringify({
      schemaVersion: 2,
      commonSha256: Object.fromEntries(
        Object.keys(common).map((filename) => [filename, sha256(join(templateDir, filename))])
      ),
      targets: {
        [target]: {
          targetSha256: sha256(join(targetDir, ORCAD_BUILD_TARGET_FILENAME)),
          watcherSha256: sha256(join(targetDir, 'watcher.node')),
          browserName: 'agent-browser-linux-x64',
          browserSha256: sha256(join(targetDir, 'agent-browser-linux-x64'))
        }
      }
    })
  )
  return { root, templateDir, cacheRoot, runtimePath }
}

describe('assembleOrcadArtifact', () => {
  it('gives Windows executable naming a new immutable slot identity', async () => {
    const target = 'win32-x64' as const
    const fixture = createTemplate(target)
    const artifactDir = await assembleOrcadArtifact({ ...fixture, target })
    expect(readFileSync(join(artifactDir, 'bun-runtime.exe'), 'utf8')).toBe('bun-executable')
    expect(existsSync(join(artifactDir, 'bun-runtime'))).toBe(false)
    const oldHash = createHash('sha256')
    for (const filename of orcadArtifactFilenames(target)) {
      oldHash.update(readFileSync(join(artifactDir, filename)))
    }
    oldHash.update('browser')
    const oldVersion = `0.1.0+${oldHash.digest('hex').slice(0, 12)}`
    const oldDir = join(fixture.cacheRoot, target, oldVersion)
    write(join(oldDir, 'bun-runtime'), 'legacy-slot-must-stay-unchanged')
    expect(artifactDir).not.toBe(oldDir)
    await expect(assembleOrcadArtifact({ ...fixture, target })).resolves.toBe(artifactDir)
    expect(readFileSync(join(oldDir, 'bun-runtime'), 'utf8')).toBe(
      'legacy-slot-must-stay-unchanged'
    )
  })

  it('assembles a complete content-addressed target directory', async () => {
    const fixture = createTemplate()
    const artifactDir = await assembleOrcadArtifact({
      templateDir: fixture.templateDir,
      cacheRoot: fixture.cacheRoot,
      target: TARGET,
      runtimePath: fixture.runtimePath
    })

    const version = readFileSync(join(artifactDir, ORCAD_VERSION_FILENAME), 'utf8').trim()
    expect(version).toMatch(/^0\.1\.0\+[a-f0-9]{12}$/u)
    expect(artifactDir).toBe(join(fixture.cacheRoot, TARGET, version))
    expect(readFileSync(join(artifactDir, ORCAD_BUILD_TARGET_FILENAME), 'utf8').trim()).toBe(TARGET)
    for (const filename of orcadArtifactFilenames()) {
      expect(readFileSync(join(artifactDir, filename)).byteLength).toBeGreaterThan(0)
    }
    expect(readFileSync(join(artifactDir, 'agent-browser-linux-x64'), 'utf8')).toBe('browser')
  })

  it('rejects a packaged native file that does not match its manifest', async () => {
    const fixture = createTemplate()
    write(
      join(fixture.templateDir, ORCAD_TEMPLATE_TARGETS_DIR, TARGET, 'watcher.node'),
      'corrupted'
    )

    await expect(
      assembleOrcadArtifact({
        templateDir: fixture.templateDir,
        cacheRoot: fixture.cacheRoot,
        target: TARGET,
        runtimePath: fixture.runtimePath
      })
    ).rejects.toThrow('watcher checksum mismatch')
  })

  it('rejects a self-consistent target marker for a different native slot', async () => {
    const fixture = createTemplate()
    const targetPath = join(
      fixture.templateDir,
      ORCAD_TEMPLATE_TARGETS_DIR,
      TARGET,
      ORCAD_BUILD_TARGET_FILENAME
    )
    write(targetPath, 'linux-x64-musl\n')
    const manifestPath = join(fixture.templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      targets: Record<string, { targetSha256: string }>
    }
    manifest.targets[TARGET]!.targetSha256 = sha256(targetPath)
    write(manifestPath, JSON.stringify(manifest))

    await expect(
      assembleOrcadArtifact({
        templateDir: fixture.templateDir,
        cacheRoot: fixture.cacheRoot,
        target: TARGET,
        runtimePath: fixture.runtimePath
      })
    ).rejects.toThrow('target identity does not match')
  })

  it('rebuilds a content-addressed cache entry whose bytes were corrupted', async () => {
    const fixture = createTemplate()
    const first = await assembleOrcadArtifact({
      templateDir: fixture.templateDir,
      cacheRoot: fixture.cacheRoot,
      target: TARGET,
      runtimePath: fixture.runtimePath
    })
    write(join(first, 'orcad.js'), 'corrupted-cache-entry')

    const rebuilt = await assembleOrcadArtifact({
      templateDir: fixture.templateDir,
      cacheRoot: fixture.cacheRoot,
      target: TARGET,
      runtimePath: fixture.runtimePath
    })

    expect(rebuilt).toBe(first)
    expect(readFileSync(join(rebuilt, 'orcad.js'), 'utf8')).toBe('orcad-entry')
  })

  it('rejects an optional browser without a matching manifest checksum', async () => {
    const fixture = createTemplate()
    const manifestPath = join(fixture.templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      targets: Record<string, Record<string, unknown>>
    }
    delete manifest.targets[TARGET]?.browserSha256
    write(manifestPath, JSON.stringify(manifest))

    await expect(
      assembleOrcadArtifact({
        templateDir: fixture.templateDir,
        cacheRoot: fixture.cacheRoot,
        target: TARGET,
        runtimePath: fixture.runtimePath
      })
    ).rejects.toThrow('browserName and browserSha256')
  })

  it('rejects a manifest that omits a required common artifact checksum', async () => {
    const fixture = createTemplate()
    const manifestPath = join(fixture.templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      commonSha256: Record<string, string>
    }
    delete manifest.commonSha256['orcad.js']
    write(manifestPath, JSON.stringify(manifest))

    await expect(
      assembleOrcadArtifact({
        templateDir: fixture.templateDir,
        cacheRoot: fixture.cacheRoot,
        target: TARGET,
        runtimePath: fixture.runtimePath
      })
    ).rejects.toThrow('manifest omits orcad.js')
  })
})
