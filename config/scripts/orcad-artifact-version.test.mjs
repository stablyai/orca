import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  orcadArtifactFilenames,
  orcadRipgrepArtifact
} from '../../src/shared/orcad-artifacts.ts'
import { SERVER_TARGETS } from '../../src/shared/node-runtime-pin.ts'
import { orcadAgentBrowserNativeName } from '../../src/shared/orcad-agent-browser-name.ts'
import { readOrcadArtifactIdentity } from '../../src/main/orcad/orcad-artifact-identity.ts'
import { computeOrcadFullVersion } from './orcad-artifact-version.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createArtifactDirectory(target = 'linux-x64-glibc') {
  const directory = mkdtempSync(join(tmpdir(), 'orcad-version-'))
  directories.push(directory)
  for (const filename of orcadArtifactFilenames(target)) {
    const path = join(directory, filename)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, filename)
  }
  writeFileSync(join(directory, ORCAD_SERVER_TARGET_FILENAME), `${target}\n`)
  return directory
}

describe('standalone runtime version', () => {
  it('changes when a shipped search binary changes and rejects a missing binary', () => {
    const target = 'linux-x64-glibc'
    const dir = createArtifactDirectory(target)
    const before = computeOrcadFullVersion(dir, { target })
    const binary = join(dir, orcadRipgrepArtifact(target))
    writeFileSync(binary, 'updated binary')
    expect(computeOrcadFullVersion(dir, { target })).not.toBe(before)
    rmSync(binary)
    expect(() => computeOrcadFullVersion(dir, { target })).toThrow(orcadRipgrepArtifact(target))
  })

  it('keys the version on the referenced runtime digest rather than its bytes', () => {
    const target = 'darwin-arm64'
    const dir = createArtifactDirectory(target)
    writeFileSync(join(dir, ORCAD_NODE_RUNTIME_MARKER_FILENAME), `${'a'.repeat(64)}\n`)
    const before = computeOrcadFullVersion(dir, { target })
    writeFileSync(join(dir, ORCAD_NODE_RUNTIME_MARKER_FILENAME), `${'b'.repeat(64)}\n`)
    expect(computeOrcadFullVersion(dir, { target })).not.toBe(before)
  })

  it.each(SERVER_TARGETS)(
    'matches the installed %s identity with and without its optional browser',
    async (target) => {
      const dir = createArtifactDirectory(target)
      const [platform, arch] = target.split('-')
      const agentBrowserFilename = orcadAgentBrowserNativeName(
        platform,
        arch,
        target.endsWith('-musl') ? 'musl' : 'glibc'
      )
      const options = { target, agentBrowserFilename }
      const withoutBrowser = computeOrcadFullVersion(dir, options)
      expect(withoutBrowser).toBe(await readOrcadArtifactIdentity(dir))
      writeFileSync(join(dir, agentBrowserFilename), 'browser')
      const withBrowser = computeOrcadFullVersion(dir, options)
      expect(withBrowser).not.toBe(withoutBrowser)
      expect(withBrowser).toBe(await readOrcadArtifactIdentity(dir))
      writeFileSync(join(dir, agentBrowserFilename), 'updated-browser')
      expect(computeOrcadFullVersion(dir, options)).not.toBe(withBrowser)
      expect(computeOrcadFullVersion(dir, options)).toBe(await readOrcadArtifactIdentity(dir))
    }
  )
})
