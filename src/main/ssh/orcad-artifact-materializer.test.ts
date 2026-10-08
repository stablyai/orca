import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pruneOrcadArtifactCache } from '../orcad/orcad-artifact-cache-retention'
import { z } from 'zod'
import {
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_COMPAT_ASSETS,
  pinnedNodeRuntimeAsset,
  type NodeRuntimeTarget
} from '../../shared/node-runtime-pin'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  ORCAD_VERSION_FILENAME,
  orcadArtifactFilenames,
  orcadRipgrepArtifact,
  orcadTemplateCommonFilenames,
  orcadTemplateTargetFilenames
} from '../../shared/orcad-artifacts'
import { readOrcadArtifactIdentity } from '../orcad/orcad-artifact-identity'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../../shared/app-environment'
import {
  assembleOrcadArtifact,
  getOrcadTemplateCandidates,
  materializeOrcadArtifact,
  resetOrcadArtifactMaterializationsForTests
} from './orcad-artifact-materializer'

const TARGET = 'linux-x64-glibc' as const
const temporaryDirs: string[] = []

afterEach(() => {
  resetOrcadArtifactMaterializationsForTests()
  vi.clearAllMocks()
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

const ManifestSchema = z
  .object({
    targets: z.record(
      z.string(),
      z.object({ files: z.record(z.string(), z.string()) }).passthrough()
    ),
    commonSha256: z.record(z.string(), z.string())
  })
  .passthrough()

function targetContents(target: NodeRuntimeTarget, filename: string): string {
  if (filename === ORCAD_SERVER_TARGET_FILENAME) {
    return `${target}\n`
  }
  if (filename === ORCAD_NODE_RUNTIME_MARKER_FILENAME) {
    return `${pinnedNodeRuntimeAsset(target).executableSha256}\n`
  }
  return `${target}:${filename}`
}

function createTemplate(target: NodeRuntimeTarget = TARGET): {
  templateDir: string
  cacheRoot: string
} {
  const root = mkdtempSync(join(tmpdir(), 'orcad-artifact-template-'))
  temporaryDirs.push(root)
  const templateDir = join(root, 'template')
  const cacheRoot = join(root, 'cache')
  const commonSha256: Record<string, string> = {}
  for (const filename of orcadTemplateCommonFilenames()) {
    write(join(templateDir, filename), filename === 'orcad.js' ? 'orcad-entry' : filename)
    commonSha256[filename] = sha256(join(templateDir, filename))
  }
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  const files: Record<string, string> = {}
  for (const filename of orcadTemplateTargetFilenames(target)) {
    write(join(targetDir, filename), targetContents(target, filename))
    files[filename] = sha256(join(targetDir, filename))
  }
  write(join(targetDir, 'agent-browser-linux-x64'), 'browser')
  write(
    join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME),
    JSON.stringify({
      schemaVersion: 3,
      commonSha256,
      targets: {
        [target]: {
          files,
          browserName: 'agent-browser-linux-x64',
          browserSha256: sha256(join(targetDir, 'agent-browser-linux-x64'))
        }
      }
    })
  )
  return { templateDir, cacheRoot }
}

function rewriteManifest(
  templateDir: string,
  change: (manifest: z.infer<typeof ManifestSchema>) => void
): void {
  const manifestPath = join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  change(manifest)
  write(manifestPath, JSON.stringify(manifest))
}

describe('assembleOrcadArtifact', () => {
  it('reuses the same version from cache after retention evicts other versions', async () => {
    const fixture = createTemplate()
    const first = await assembleOrcadArtifact({ ...fixture, target: TARGET })
    const entry = statSync(join(first, 'orcad.js'))
    // Older versions of the same target, used before this one.
    const older = [1, 2, 3].map((age) => {
      const dir = join(fixture.cacheRoot, TARGET, `0.0.${age}+old`)
      write(join(dir, 'orcad.js'), 'old')
      const at = new Date(Date.now() - age * 60_000)
      utimesSync(dir, at, at)
      return dir
    })
    const removed = await pruneOrcadArtifactCache(fixture.cacheRoot, {
      inUseVersions: new Set([basename(first)])
    })

    expect(removed).toEqual([older[2]])
    const second = await assembleOrcadArtifact({ ...fixture, target: TARGET })
    expect(second).toBe(first)
    // A verified hit: the same files, not a re-copy.
    expect(statSync(join(second, 'orcad.js')).ino).toBe(entry.ino)
  })

  it.skipIf(process.platform === 'win32')(
    'restores executable modes from a template copied without them',
    async () => {
      const target = 'darwin-arm64' as const
      const fixture = createTemplate(target)
      const executables = [
        orcadRipgrepArtifact(target),
        'node_modules/node-pty/build/Release/spawn-helper'
      ]
      for (const filename of executables) {
        chmodSync(join(fixture.templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target, filename), 0o644)
      }
      const artifactDir = await assembleOrcadArtifact({ ...fixture, target })
      for (const filename of executables) {
        expect(statSync(join(artifactDir, filename)).mode & 0o777).toBe(0o755)
      }
    }
  )

  it('assembles the rung B compat slot against the compat runtime', async () => {
    const target = 'linux-x64-glibc217' as const
    const fixture = createTemplate(target)
    const artifactDir = await assembleOrcadArtifact({ ...fixture, target })

    expect(readFileSync(join(artifactDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME), 'utf8').trim()).toBe(
      NODE_RUNTIME_COMPAT_ASSETS[target].executableSha256
    )
    expect(
      readFileSync(join(artifactDir, 'node_modules/node-pty/build/Release/pty.node'), 'utf8')
    ).toBe(`${target}:node_modules/node-pty/build/Release/pty.node`)
    // The host-side preflight hashes it the same way, so managed orcad can run it.
    expect(await readOrcadArtifactIdentity(artifactDir)).toBe(
      readFileSync(join(artifactDir, ORCAD_VERSION_FILENAME), 'utf8').trim()
    )
  })

  it('refuses a compat slot that names the default runtime', async () => {
    const target = 'linux-x64-glibc217' as const
    const fixture = createTemplate(target)
    const marker = join(
      fixture.templateDir,
      ORCAD_TEMPLATE_TARGETS_DIR,
      target,
      ORCAD_NODE_RUNTIME_MARKER_FILENAME
    )
    write(marker, `${NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256}\n`)
    rewriteManifest(fixture.templateDir, (manifest) => {
      const entry = manifest.targets[target]
      if (entry) {
        entry.files[ORCAD_NODE_RUNTIME_MARKER_FILENAME] = sha256(marker)
      }
    })
    await expect(assembleOrcadArtifact({ ...fixture, target })).rejects.toThrow(
      'does not reference the pinned Node'
    )
  })

  it('assembles a complete content-addressed slot that references the pinned Node', async () => {
    const fixture = createTemplate()
    const artifactDir = await assembleOrcadArtifact({ ...fixture, target: TARGET })

    const version = readFileSync(join(artifactDir, ORCAD_VERSION_FILENAME), 'utf8').trim()
    expect(version).toMatch(/^0\.1\.0\+[a-f0-9]{12}$/u)
    expect(await readOrcadArtifactIdentity(artifactDir)).toBe(version)
    write(join(artifactDir, 'orcad.js'), 'changed-installed-bytes')
    expect(await readOrcadArtifactIdentity(artifactDir)).not.toBe(version)
    expect(artifactDir).toBe(join(fixture.cacheRoot, TARGET, version))
    expect(readFileSync(join(artifactDir, ORCAD_SERVER_TARGET_FILENAME), 'utf8').trim()).toBe(
      TARGET
    )
    expect(readFileSync(join(artifactDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME), 'utf8').trim()).toBe(
      NODE_RUNTIME_ASSETS[TARGET].executableSha256
    )
    for (const filename of orcadArtifactFilenames(TARGET)) {
      expect(readFileSync(join(artifactDir, filename)).byteLength).toBeGreaterThan(0)
    }
    // A Bun-era client's selector would exit 78 on this file without a Bun runtime (R5).
    expect(() => readFileSync(join(artifactDir, ORCAD_BUILD_TARGET_FILENAME))).toThrow()
    expect(readFileSync(join(artifactDir, 'agent-browser-linux-x64'), 'utf8')).toBe('browser')
  })

  it('rejects a packaged native file that does not match its manifest', async () => {
    const fixture = createTemplate()
    write(
      join(
        fixture.templateDir,
        ORCAD_TEMPLATE_TARGETS_DIR,
        TARGET,
        'node_modules/node-pty/build/Release/pty.node'
      ),
      'corrupted'
    )

    await expect(assembleOrcadArtifact({ ...fixture, target: TARGET })).rejects.toThrow(
      'node_modules/node-pty/build/Release/pty.node checksum mismatch'
    )
  })

  it('rejects a self-consistent target marker for a different native slot', async () => {
    const fixture = createTemplate()
    const targetPath = join(
      fixture.templateDir,
      ORCAD_TEMPLATE_TARGETS_DIR,
      TARGET,
      ORCAD_SERVER_TARGET_FILENAME
    )
    write(targetPath, 'linux-x64-musl\n')
    rewriteManifest(fixture.templateDir, (manifest) => {
      manifest.targets[TARGET]!.files[ORCAD_SERVER_TARGET_FILENAME] = sha256(targetPath)
    })

    await expect(assembleOrcadArtifact({ ...fixture, target: TARGET })).rejects.toThrow(
      'target identity does not match'
    )
  })

  it('rejects a self-consistent runtime reference to another Node', async () => {
    const fixture = createTemplate()
    const markerPath = join(
      fixture.templateDir,
      ORCAD_TEMPLATE_TARGETS_DIR,
      TARGET,
      ORCAD_NODE_RUNTIME_MARKER_FILENAME
    )
    write(markerPath, `${'0'.repeat(64)}\n`)
    rewriteManifest(fixture.templateDir, (manifest) => {
      manifest.targets[TARGET]!.files[ORCAD_NODE_RUNTIME_MARKER_FILENAME] = sha256(markerPath)
    })

    await expect(assembleOrcadArtifact({ ...fixture, target: TARGET })).rejects.toThrow(
      'does not reference the pinned Node'
    )
  })

  it('repairs corrupt artifacts beside the old entry and reuses the repair', async () => {
    const fixture = createTemplate()
    const first = await assembleOrcadArtifact({ ...fixture, target: TARGET })
    write(join(first, 'orcad.js'), 'corrupted-cache-entry')

    const repaired = await assembleOrcadArtifact({ ...fixture, target: TARGET })
    expect(repaired).not.toBe(first)
    expect(readFileSync(join(repaired, 'orcad.js'))).toEqual(
      readFileSync(join(fixture.templateDir, 'orcad.js'))
    )
    expect(await assembleOrcadArtifact({ ...fixture, target: TARGET })).toBe(repaired)
    expect(readFileSync(join(first, 'orcad.js'), 'utf8')).toBe('corrupted-cache-entry')
  })

  it('rejects an optional browser without a matching manifest checksum', async () => {
    const fixture = createTemplate()
    rewriteManifest(fixture.templateDir, (manifest) => {
      delete manifest.targets[TARGET]?.browserSha256
    })

    await expect(assembleOrcadArtifact({ ...fixture, target: TARGET })).rejects.toThrow(
      'browserName and browserSha256'
    )
  })

  it('rejects a manifest that omits a required common artifact checksum', async () => {
    const fixture = createTemplate()
    rewriteManifest(fixture.templateDir, (manifest) => {
      delete manifest.commonSha256['orcad.js']
    })

    await expect(assembleOrcadArtifact({ ...fixture, target: TARGET })).rejects.toThrow(
      'manifest omits orcad.js'
    )
  })
})

describe('materializeOrcadArtifact cancellation', () => {
  it('detaches a cancelled caller without cancelling the shared cache fill', async () => {
    const fixture = createTemplate()
    const first = new AbortController()
    const one = materializeOrcadArtifact(TARGET, { ...fixture, signal: first.signal })
    const two = materializeOrcadArtifact(TARGET, fixture)
    first.abort(new Error('first cancelled'))
    await expect(one).rejects.toThrow('first cancelled')
    const artifact = await two
    expect(readFileSync(join(artifact, 'orcad.js'), 'utf8')).toBe('orcad-entry')
  })

  it('refuses an already cancelled request before reading artifacts', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(materializeOrcadArtifact(TARGET, { signal: controller.signal })).rejects.toThrow(
      'cancelled'
    )
  })
})

describe('packaged template lookup', () => {
  const originalResourcesPath = process.resourcesPath
  const originalTemplatePath = process.env.ORCA_ORCAD_TEMPLATE_PATH
  let previousEnvironment: AppEnvironment | null = null

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true,
      writable: true
    })
    if (originalTemplatePath === undefined) {
      delete process.env.ORCA_ORCAD_TEMPLATE_PATH
    } else {
      process.env.ORCA_ORCAD_TEMPLATE_PATH = originalTemplatePath
    }
    if (previousEnvironment) {
      setAppEnvironment(previousEnvironment)
    }
  })

  /** An installed app: electron-builder copies out/orcad-template to Resources/orcad-template. */
  function installPackagedApp(): { resourcesDir: string; userData: string } {
    const fixture = createTemplate()
    const root = dirname(fixture.templateDir)
    const resourcesDir = join(root, 'Resources')
    mkdirSync(resourcesDir)
    renameSync(fixture.templateDir, join(resourcesDir, 'orcad-template'))
    const userData = join(root, 'userData')
    delete process.env.ORCA_ORCAD_TEMPLATE_PATH
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesDir,
      configurable: true,
      writable: true
    })
    previousEnvironment = hasAppEnvironment() ? getAppEnvironment() : null
    setAppEnvironment({
      getPath: () => userData,
      getAppPath: () => join(resourcesDir, 'app.asar'),
      getVersion: () => '0.0.0-test',
      isPackaged: () => true,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    return { resourcesDir, userData }
  }

  it('materializes from Resources/orcad-template into userData with no explicit paths', async () => {
    const { resourcesDir, userData } = installPackagedApp()

    expect(getOrcadTemplateCandidates()[0]).toBe(join(resourcesDir, 'orcad-template'))
    const artifact = await materializeOrcadArtifact(TARGET)
    expect(dirname(dirname(artifact))).toBe(join(userData, 'orcad-artifacts'))
    expect(readFileSync(join(artifact, 'orcad.js'), 'utf8')).toBe('orcad-entry')
  })

  it('reports a build that shipped no template, which relays treat as a legacy fallback', async () => {
    const { resourcesDir } = installPackagedApp()
    rmSync(join(resourcesDir, 'orcad-template'), { recursive: true })

    await expect(materializeOrcadArtifact(TARGET)).rejects.toThrow(
      'The packaged orcad deployment template is missing'
    )
  })
})
