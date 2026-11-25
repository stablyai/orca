import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildClaudeChildProcessEnv } from '../../child-process/claude-child-process-environment'
import { claudeConfigDirEnvPatch, withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'
import { claudeChildEnv } from './claude-structured-child-env'

let home: string
let profileHome: string

// A temp HOME stands for the user's home.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-claude-pin-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
  profileHome = join(home, 'Orca Profiles', 'work', 'orca-home', 'agents', 'claude')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

const patch = (accountHome: string, env: NodeJS.ProcessEnv) =>
  claudeConfigDirEnvPatch(accountHome, { env, platform: 'darwin' })

describe('claudeConfigDirEnvPatch in a profile', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_HOME_DIR', join(home, 'Orca Profiles', 'work', 'orca-home'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', profileHome)
  })

  it("pins the profile's folder in a child env without the variable", () => {
    expect(patch(profileHome, {})).toEqual({ CLAUDE_CONFIG_DIR: profileHome })
  })

  it('does not pin ~/.claude in a child env without the variable', () => {
    expect(patch(join(home, '.claude'), {})).toEqual({})
  })

  it("pins ~/.claude in an env that keeps the profile's variable", () => {
    expect(patch(join(home, '.claude'), { CLAUDE_CONFIG_DIR: profileHome })).toEqual({
      CLAUDE_CONFIG_DIR: join(home, '.claude')
    })
  })

  it("gives the structured chat's spawn env the profile's folder", () => {
    const launchEnv = claudeChildEnv(
      {
        command: 'claude',
        prefixArgs: [],
        overlay: undefined,
        inheritedEnv: { PATH: '/usr/bin', HOME: home, CLAUDE_CONFIG_DIR: profileHome }
      },
      undefined,
      { runtimeOnPath: false }
    )
    expect(launchEnv.CLAUDE_CONFIG_DIR).toBeUndefined()
    const spawnEnv = { ...launchEnv, ...claudeConfigDirEnvPatch(profileHome, { env: launchEnv }) }
    const finalEnv = buildClaudeChildProcessEnv(spawnEnv, {
      inheritedEnv: withoutInheritedClaudeConfigDir(process.env)
    })
    expect(finalEnv.CLAUDE_CONFIG_DIR).toBe(profileHome)
  })
})
