import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as NodeOsModule from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOsModule>()
  return { ...actual, default: actual, homedir: () => state.home }
})

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

import { MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS } from '../managed-agent-hook-registry'

describe('managed hook script refresh and owned profile cleanup', () => {
  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), 'orca-hook-refresh-main-thread-'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(state.home, '.claude'))
    installFakeAppEnvironment({ getPath: () => join(state.home, 'user-data') })
    vi.stubEnv('ORCA_USER_DATA_PATH', join(state.home, 'user-data'))
    vi.stubEnv('GROK_HOME', undefined)
    vi.stubEnv('KIMI_CODE_HOME', undefined)
    vi.stubEnv('XDG_CONFIG_HOME', undefined)
  })

  afterEach(async () => {
    await rm(state.home, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('refreshes stale scripts and removes owned profile plugins while preserving unowned files', async () => {
    const hooksDir = join(state.home, '.orca', 'agent-hooks')
    const claudeScript = join(
      hooksDir,
      process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh'
    )
    await mkdir(hooksDir, { recursive: true })
    await writeFile(claudeScript, 'stale', 'utf-8')
    const legacyRoot = join(state.home, '.claude', 'skills', 'orca-agent-view')
    await mkdir(join(legacyRoot, '.claude-plugin'), { recursive: true })
    await mkdir(join(legacyRoot, 'hooks'))
    await writeFile(
      join(legacyRoot, '.claude-plugin', 'orca-managed.json'),
      '{"owner":"stablyai/orca/claude-agent-view"}'
    )
    const modScript = join(
      state.home,
      '.claude',
      'skills',
      'orca-agent-view',
      'hooks',
      'register.js'
    )
    await writeFile(modScript, 'stale', 'utf8')
    const profileRoot = join(state.home, 'user-data', 'claude-profiles')
    const profileMods: string[] = []
    for (const id of ['first', 'second']) {
      const home = join(profileRoot, id, 'home')
      const legacyRoot = join(home, 'skills', 'orca-agent-view')
      await mkdir(join(legacyRoot, '.claude-plugin'), { recursive: true })
      await mkdir(join(legacyRoot, 'hooks'))
      await writeFile(
        join(legacyRoot, '.claude-plugin', 'orca-managed.json'),
        '{"owner":"stablyai/orca/claude-agent-view"}'
      )
      const mod = join(home, 'skills', 'orca-agent-view', 'hooks', 'register.js')
      await writeFile(mod, 'stale', 'utf8')
      profileMods.push(mod)
    }
    const absent = join(profileRoot, 'absent', 'home')
    await mkdir(absent, { recursive: true })
    const unowned = join(profileRoot, 'unowned', 'home', 'skills', 'orca-agent-view')
    await mkdir(join(unowned, '.claude-plugin'), { recursive: true })
    await mkdir(join(unowned, 'hooks'))
    await writeFile(join(unowned, '.claude-plugin', 'orca-managed.json'), '{"owner":"someone"}')
    await writeFile(join(unowned, 'hooks', 'register.js'), 'user-owned')

    for (const [, refresh] of MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS) {
      await refresh()
    }

    const refreshed = await readFile(claudeScript, 'utf8')
    expect(refreshed).not.toBe('stale')
    expect(refreshed).toContain(
      process.platform === 'win32' ? 'echo {}' : 'trap orca_hook_finish EXIT'
    )
    await expect(readFile(modScript, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    for (const mod of profileMods) {
      await expect(readFile(mod, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await readFile(join(unowned, 'hooks', 'register.js'), 'utf8')).toBe('user-owned')
    await expect(
      readFile(join(absent, 'skills', 'orca-agent-view', 'hooks', 'register.js'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
