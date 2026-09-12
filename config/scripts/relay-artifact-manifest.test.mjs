// Packaged-relay contract: what `build:relay` actually writes to disk.
//
// Asserts against a real build, not the source tree — the unit suites cannot see
// this gap, because the WSL transcript dispatcher runs in-process under vitest
// and never forks.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RELAY_BUILD_PLATFORMS,
  RELAY_VERSION_FILENAME,
  isWindowsRelayPlatform,
  relayArtifactFilenames
} from '../../src/shared/relay-artifacts.ts'

const projectDir = resolve(import.meta.dirname, '../..')
// Its own tree: building into out/relay would clobber a developer's build and
// race the suites that read it.
const relayOutDir = mkdtempSync(join(tmpdir(), 'orca-relay-contract-'))

beforeAll(() => {
  execFileSync('node', [join(projectDir, 'config', 'scripts', 'build-relay.mjs')], {
    cwd: projectDir,
    stdio: 'pipe',
    env: { ...process.env, ORCA_RELAY_OUT_ROOT: relayOutDir }
  })
}, 120_000)

afterAll(() => {
  rmSync(relayOutDir, { recursive: true, force: true })
})

describe('packaged relay artifact manifest', () => {
  it.each([...RELAY_BUILD_PLATFORMS])('emits exactly the declared artifacts for %s', (platform) => {
    const outDir = join(relayOutDir, platform)
    const expected = relayArtifactFilenames(isWindowsRelayPlatform(platform))

    for (const filename of expected) {
      expect(existsSync(join(outDir, filename)), `${platform}/${filename} missing`).toBe(true)
    }
    // Exactly, not merely at least: an undeclared artifact ships unhashed and
    // unprobed, which is the same gap in the other direction.
    const emitted = readdirSync(outDir)
      .filter((name) => name !== RELAY_VERSION_FILENAME)
      .sort()
    expect(emitted).toEqual([...expected].sort())
  })

  it.each([...RELAY_BUILD_PLATFORMS])('hashes every declared artifact for %s', (platform) => {
    const outDir = join(relayOutDir, platform)
    const hash = createHash('sha256')
    for (const filename of relayArtifactFilenames(isWindowsRelayPlatform(platform))) {
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
})
