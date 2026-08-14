import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexStructuredHomeIsolation } from './codex-structured-home-isolation'

const roots: string[] = []

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

function fixture(): { root: string; source: string; isolated: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-home-'))
  roots.push(root)
  const source = join(root, 'source')
  const isolated = join(root, 'isolated')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'auth.json'), '{"token":"secret"}', { mode: 0o600 })
  writeFileSync(join(source, 'config.toml'), '[mcp_servers.unsafe]\ncommand = "bad"\n')
  mkdirSync(join(source, 'skills'), { recursive: true })
  writeFileSync(join(source, 'skills', 'unsafe.md'), 'do not copy')
  return { root, source, isolated }
}

describe('CodexStructuredHomeIsolation', () => {
  it('copies only credentials and writes a minimal deny-all config with private modes', async () => {
    const { source, isolated } = fixture()
    const homes = await CodexStructuredHomeIsolation.open(isolated)
    const home = await homes.prepare('session-1', source)

    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{"token":"secret"}')
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(
      'web_search = "disabled"\nmcp_servers = {}\n'
    )
    expect(existsSync(join(home, 'skills'))).toBe(false)
    expect(lstatSync(home).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(home, 'config.toml')).mode & 0o777).toBe(0o600)

    await homes.release('session-1', home)
    expect(existsSync(home)).toBe(false)
  })

  it('does not remove another process home and rejects a symlinked auth source', async () => {
    const { root, source, isolated } = fixture()
    mkdirSync(isolated, { recursive: true })
    writeFileSync(join(isolated, 'stale-secret'), 'stale')
    const staleProcessHome = join(isolated, 'process-99999999-stale')
    const liveProcessHome = join(isolated, `process-${process.pid}-live`)
    mkdirSync(staleProcessHome)
    mkdirSync(liveProcessHome)
    const homes = await CodexStructuredHomeIsolation.open(isolated)
    expect(existsSync(join(isolated, 'stale-secret'))).toBe(true)
    expect(existsSync(staleProcessHome)).toBe(false)
    expect(existsSync(liveProcessHome)).toBe(true)

    rmSync(join(source, 'auth.json'))
    const outside = join(root, 'outside-auth.json')
    writeFileSync(outside, '{"token":"outside"}')
    const { symlinkSync } = await import('node:fs')
    symlinkSync(outside, join(source, 'auth.json'))
    await expect(homes.prepare('session-1', source)).rejects.toThrow('regular file')
  })

  it('does not let an older release remove a newer session home', async () => {
    const { source, isolated } = fixture()
    const homes = await CodexStructuredHomeIsolation.open(isolated)
    const oldHome = await homes.prepare('session-1', source)
    const newHome = await homes.prepare('session-1', source)

    await homes.release('session-1', oldHome)
    expect(existsSync(newHome)).toBe(true)
    await homes.release('session-1', newHome)
    expect(existsSync(newHome)).toBe(false)
  })
})
