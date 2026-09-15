import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DshConsoleHookService } from './hook-service'

describe('DSH Console hook lifecycle', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orca-dsh-hook-'))
    vi.stubEnv('DSH_HOME', home)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })
  it('installs, refreshes and removes only its own profile entry and files', async () => {
    const service = new DshConsoleHookService()
    expect(service.getStatus().state).toBe('not_installed')
    expect((await service.install()).state).toBe('installed')
    const patchPath = join(home, 'profiles/dsh-console/cordis.patch.yml')
    const first = await readFile(patchPath, 'utf8')
    expect((await service.install()).state).toBe('installed')
    expect(await readFile(patchPath, 'utf8')).toBe(first)
    expect((await service.remove()).state).toBe('not_installed')
    expect(service.getStatus().state).toBe('not_installed')
    expect((await service.remove()).state).toBe('not_installed')
  })
  it('keeps the final removal when it races an in-flight install', async () => {
    const first = new DshConsoleHookService()
    const second = new DshConsoleHookService()
    const results = await Promise.all([first.install(), second.remove()])
    expect(results.map((result) => result.state)).toEqual(['installed', 'not_installed'])
    expect(first.getStatus().state).toBe('not_installed')
    await expect(
      readFile(join(home, 'profiles/dsh-console/orca-status/index.mjs'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('repairs a missing managed manifest before reporting installed', async () => {
    const service = new DshConsoleHookService()
    await service.install()
    await rm(join(home, 'profiles/dsh-console/orca-status/package.json'))
    expect(service.getStatus().state).not.toBe('installed')
    expect((await service.install()).state).toBe('installed')
  })
  it('preserves significant whitespace in the configured home path', async () => {
    vi.stubEnv('DSH_HOME', join(home, 'custom home '))
    const service = new DshConsoleHookService()
    expect((await service.install()).state).toBe('installed')
    expect(service.getStatus().configPath).toBe(
      join(home, 'custom home ', 'profiles/dsh-console/cordis.patch.yml')
    )
    await expect(
      readFile(join(home, 'custom home ', 'profiles/dsh-console/orca-status/index.mjs'), 'utf8')
    ).resolves.toContain('Managed by Orca')
  })
  it('refuses a foreign module or manifest before changing user configuration', async () => {
    const dir = join(home, 'profiles/dsh-console/orca-status')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), '{"name":"user-plugin"}')
    const service = new DshConsoleHookService()
    expect(service.getStatus()).toMatchObject({
      state: 'partial',
      detail: 'Existing bridge manifest is not managed by Orca'
    })
    expect((await service.install()).state).toBe('error')
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('{"name":"user-plugin"}')
    await expect(readFile(join(dir, '../cordis.patch.yml'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
