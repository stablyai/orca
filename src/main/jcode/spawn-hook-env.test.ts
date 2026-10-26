import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getJcodeSpawnScriptPath } from './hook-settings'

describe('managed jcode spawn env', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orca-jcode-spawn home-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  it('quotes the installed local script, including spaces', async () => {
    const script = getJcodeSpawnScriptPath()
    await mkdir(dirname(script), { recursive: true })
    await writeFile(script, '')
    const { resolveJcodeSpawnHookEnv } = await import('./spawn-hook-env')
    expect(await resolveJcodeSpawnHookEnv({ wsl: false })).toBe(`'${script}'`)
  })

  it.each([{ connectionId: 'ssh:x', wsl: false }, { wsl: true }])(
    'does not export a host script outside the local host: %o',
    async (args) => {
      const script = getJcodeSpawnScriptPath()
      await mkdir(dirname(script), { recursive: true })
      await writeFile(script, '')
      const { resolveJcodeSpawnHookEnv } = await import('./spawn-hook-env')
      expect(await resolveJcodeSpawnHookEnv(args)).toBeUndefined()
    }
  )

  it('leaves fallback available when the script is absent', async () => {
    const { resolveJcodeSpawnHookEnv } = await import('./spawn-hook-env')
    expect(await resolveJcodeSpawnHookEnv({ wsl: false })).toBeUndefined()
  })
})
