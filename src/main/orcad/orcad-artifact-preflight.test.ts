import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { orcadArtifactFilenames } from '../../shared/orcad-artifacts'
import { runOrcadProfilePreflight } from './orcad-profile-preflight'
import { readOrcadArtifactIdentity } from './orcad-artifact-identity'
import { resolveOrcadExitCode } from './orcad-exit-code'

const fixture = vi.hoisted(() => ({
  directory: '',
  sqlite: vi.fn(async () => ({ sqliteVersion: '3.53.2', revision: 1 }))
}))
vi.mock('./orcad-app-paths', () => ({ resolveOrcadInstallRoot: () => fixture.directory }))
vi.mock('../persistence/profile-state/profile-state-runtime-preflight', () => ({
  preflightProfileStateRuntime: fixture.sqlite
}))
vi.mock('./orcad-bun-native-preflight', () => ({
  preflightOrcadBunNativeRuntime: vi.fn(async () => {})
}))

beforeEach(async () => {
  fixture.directory = await mkdtemp(join(tmpdir(), 'orcad-artifact-preflight-'))
  for (const filename of orcadArtifactFilenames('linux-x64-glibc')) {
    const path = join(fixture.directory, filename)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, filename === '.build-target' ? 'linux-x64-glibc\n' : filename)
  }
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await rm(fixture.directory, { recursive: true, force: true })
})

describe('installed artifact admission', () => {
  it('qualifies build output before its version marker is published', async () => {
    await runOrcadProfilePreflight(randomUUID())
    expect(fixture.sqlite).toHaveBeenCalledOnce()
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(await readOrcadArtifactIdentity(fixture.directory))
    )
  })

  it.each(['.build-target', 'node_modules/@parcel/watcher/watcher.node', 'bun-runtime'])(
    'refuses a missing %s as configuration before any profile probe',
    async (filename) => {
      await rm(join(fixture.directory, filename))
      const error = await runOrcadProfilePreflight(randomUUID()).catch(
        (failure: unknown) => failure
      )
      expect(resolveOrcadExitCode(error)).toBe(78)
      expect(fixture.sqlite).not.toHaveBeenCalled()
      expect(console.log).not.toHaveBeenCalled()
    }
  )

  it('refuses a malformed target even though all named files exist', async () => {
    await writeFile(join(fixture.directory, '.build-target'), 'not-a-runtime-target')
    const error = await runOrcadProfilePreflight(randomUUID()).catch((failure: unknown) => failure)
    expect(resolveOrcadExitCode(error)).toBe(78)
    expect(fixture.sqlite).not.toHaveBeenCalled()
  })
})
