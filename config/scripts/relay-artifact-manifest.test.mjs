// Packaged-relay contract: what `build:relay` actually writes to disk.
//
// Asserts against a real build, not the source tree — the unit suites cannot see
// this gap, because the WSL transcript dispatcher runs in-process under vitest
// and never forks.
import { execFileSync } from 'node:child_process'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RELAY_BUILD_PLATFORMS,
  RELAY_VERSION_FILENAME,
  relayArtifactFilenames,
  relayOptionalArtifactFilenames
} from '../../src/shared/relay-artifacts.ts'

const projectDir = resolve(import.meta.dirname, '../..')
// Its own tree: building into out/relay would clobber a developer's build and
// race the suites that read it.
const relayOutDir = mkdtempSync(join(tmpdir(), 'orca-relay-contract-'))
const bunRuntimeRoot = mkdtempSync(join(tmpdir(), 'orca-relay-bun-runtime-'))

for (const platform of RELAY_BUILD_PLATFORMS) {
  const targets = platform.startsWith('linux-')
    ? [`${platform}-glibc`, `${platform}-musl`]
    : [platform]
  for (const target of targets) {
    const platformDir = join(bunRuntimeRoot, target)
    mkdirSync(platformDir, { recursive: true })
    writeFileSync(join(platformDir, orcadBunRuntimeFilename(target)), `bun-runtime-${target}`)
  }
}

beforeAll(() => {
  execFileSync('node', [join(projectDir, 'config', 'scripts', 'build-relay.mjs')], {
    cwd: projectDir,
    stdio: 'pipe',
    env: {
      ...process.env,
      ORCA_RELAY_OUT_ROOT: relayOutDir,
      ORCA_RELAY_BUN_RUNTIME_ROOT: bunRuntimeRoot,
      ORCA_REQUIRE_RELAY_BUN_RUNTIME: '1'
    }
  })
}, 120_000)

afterAll(() => {
  rmSync(relayOutDir, { recursive: true, force: true })
  rmSync(bunRuntimeRoot, { recursive: true, force: true })
})

describe('packaged relay artifact manifest', () => {
  it('fails closed when strict Bun staging has no runtime root', () => {
    const strictOutDir = mkdtempSync(join(tmpdir(), 'orca-relay-strict-missing-'))
    const env = {
      ...process.env,
      ORCA_RELAY_OUT_ROOT: strictOutDir,
      ORCA_REQUIRE_RELAY_BUN_RUNTIME: '1'
    }
    delete env.ORCA_RELAY_BUN_RUNTIME_ROOT
    try {
      expect(() =>
        execFileSync('node', [join(projectDir, 'config', 'scripts', 'build-relay.mjs')], {
          cwd: projectDir,
          env,
          stdio: 'pipe'
        })
      ).toThrow(/ORCA_RELAY_BUN_RUNTIME_ROOT/)
    } finally {
      rmSync(strictOutDir, { recursive: true, force: true })
    }
  })

  it.each([...RELAY_BUILD_PLATFORMS])('emits exactly the declared artifacts for %s', (platform) => {
    const outDir = join(relayOutDir, platform)
    const expected = relayArtifactFilenames(platform)
    const optional = relayOptionalArtifactFilenames(platform)
    const presentOptional = optional.filter((filename) => existsSync(join(outDir, filename)))

    for (const filename of [...expected, ...presentOptional]) {
      expect(existsSync(join(outDir, filename)), `${platform}/${filename} missing`).toBe(true)
    }
    // Exactly, not merely at least: an undeclared artifact ships unhashed and
    // unprobed, which is the same gap in the other direction.
    const emitted = listFilesRelative(outDir)
      .filter((name) => name !== RELAY_VERSION_FILENAME)
      .sort()
    expect(emitted).toEqual([...expected, ...presentOptional].sort())
  })

  it.each([...RELAY_BUILD_PLATFORMS])('hashes every declared artifact for %s', (platform) => {
    const outDir = join(relayOutDir, platform)
    const hash = createHash('sha256')
    const files = [
      ...relayArtifactFilenames(platform),
      ...relayOptionalArtifactFilenames(platform).filter((filename) =>
        existsSync(join(outDir, filename))
      )
    ]
    for (const filename of files) {
      if (filename === 'bun-runtime.exe') {
        hash.update(`${filename}\0`)
      }
      hash.update(readFileSync(join(outDir, filename)))
    }
    const version = readFileSync(join(outDir, RELAY_VERSION_FILENAME), 'utf8')

    // A companion left out of the hash lets a changed relay reuse an existing
    // immutable remote directory, serving a mixed-generation install forever.
    expect(version.split('+')[1]).toBe(hash.digest('hex').slice(0, 12))
  })

  it('ships the WSL transcript helper beside the service that forks it', () => {
    for (const platform of RELAY_BUILD_PLATFORMS) {
      const outDir = join(relayOutDir, platform)
      const service = readFileSync(join(outDir, 'relay-ai-vault-service.js'), 'utf8')

      // The bundled service reaches the fork, so the entry must sit beside it:
      // the spawn resolves the child relative to its own bundle directory.
      expect(service, `${platform} service no longer forks the helper`).toContain(
        'wsl-transcript-fs-process-entry.js'
      )
      expect(
        existsSync(join(outDir, 'wsl-transcript-fs-process-entry.js')),
        `${platform} forks a helper it does not ship`
      ).toBe(true)
    }
  })

  it('marks strict WSL bundles as Bun-only and binds the policy to both versions', () => {
    const wslDir = join(relayOutDir, 'wsl')
    const hookMarker = join(wslDir, '.bun-required')
    const browserMarker = join(wslDir, '.bun-required')
    expect(readFileSync(hookMarker, 'utf8')).toBe('bun\n')
    expect(readFileSync(browserMarker, 'utf8')).toBe('bun\n')
    expect(readFileSync(join(wslDir, '.version'), 'utf8')).toMatch(/^0\.1\.0\+[a-f0-9]{12}$/u)
    expect(readFileSync(join(wslDir, '.browser-network-version'), 'utf8')).toMatch(
      /^0\.1\.0\+[a-f0-9]{12}$/u
    )
    for (const filename of [
      'bun-runtime-linux-x64-glibc',
      'bun-runtime-linux-x64-musl',
      'bun-runtime-linux-arm64-glibc',
      'bun-runtime-linux-arm64-musl'
    ]) {
      expect(existsSync(join(wslDir, filename)), `${filename} missing from strict WSL bundle`).toBe(
        true
      )
    }
  })
})

function listFilesRelative(rootDir, currentDir = rootDir) {
  const entries = []
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const path = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      entries.push(...listFilesRelative(rootDir, path))
    } else if (entry.isFile()) {
      entries.push(path.slice(rootDir.length + 1))
    }
  }
  return entries
}
