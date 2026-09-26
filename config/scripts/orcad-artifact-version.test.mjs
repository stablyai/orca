import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_RIPGREP_ARTIFACTS,
  orcadArtifactFilenames
} from '../../src/shared/orcad-artifacts.ts'
import { ORCAD_BUN_TARGETS } from '../../src/shared/orcad-bun-runtime.ts'
import { orcadAgentBrowserNativeName } from '../../src/shared/orcad-agent-browser-name.ts'
import { readOrcadArtifactIdentity } from '../../src/main/orcad/orcad-artifact-identity.ts'
import { computeOrcadFullVersion } from './orcad-artifact-version.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createArtifactDirectory(target = '') {
  const directory = mkdtempSync(join(tmpdir(), 'orcad-version-'))
  directories.push(directory)
  for (const filename of orcadArtifactFilenames(target)) {
    const path = join(directory, filename)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, filename)
  }
  writeFileSync(join(directory, ORCAD_BUILD_TARGET_FILENAME), `${target}\n`)
  return directory
}

describe('standalone runtime version', () => {
  it('changes when a shipped search binary changes and rejects a missing binary', () => {
    const dir = createArtifactDirectory()
    const before = computeOrcadFullVersion(dir)
    const binary = join(dir, ORCAD_RIPGREP_ARTIFACTS[0])
    writeFileSync(binary, 'updated binary')
    expect(computeOrcadFullVersion(dir)).not.toBe(before)
    rmSync(binary)
    expect(() => computeOrcadFullVersion(dir)).toThrow(ORCAD_RIPGREP_ARTIFACTS[0])
  })

  it.each(ORCAD_BUN_TARGETS)(
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
