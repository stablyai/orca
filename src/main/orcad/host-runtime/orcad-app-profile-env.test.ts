import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_PROFILE_HOME_ENV_KEYS } from '../../../shared/app-profiles/app-profile-homes'

let home: string

// Every variable the module may set is stubbed, so none leaks into other tests.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-orcad-profile-env-'))
  vi.stubEnv('HOME', home)
  for (const key of APP_PROFILE_HOME_ENV_KEYS) {
    vi.stubEnv(key, undefined)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  rmSync(home, { recursive: true, force: true })
})

describe("orcad's first module", () => {
  it("applies the profile's folders when its data folder has the profile marker", async () => {
    const work = join(home, 'Orca Profiles', 'work')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'orca-app-profile.json'), '{"id":"work"}')
    vi.stubEnv('ORCA_USER_DATA', work)
    await import('./orcad-app-profile-env')
    expect(process.env.CODEX_HOME).toBe(join(work, 'orca-home', 'agents', 'codex'))
  })

  it('removes folders inherited from a profile for any other data folder', async () => {
    const work = join(home, 'Orca Profiles', 'work')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'orca-app-profile.json'), '{"id":"work"}')
    vi.stubEnv('ORCA_HOME_DIR', join(work, 'orca-home'))
    vi.stubEnv('CODEX_HOME', join(work, 'orca-home', 'agents', 'codex'))
    vi.stubEnv('ORCA_USER_DATA', join(home, 'orca'))
    await import('./orcad-app-profile-env')
    expect(process.env.ORCA_HOME_DIR).toBeUndefined()
    expect(process.env.CODEX_HOME).toBeUndefined()
  })
})
