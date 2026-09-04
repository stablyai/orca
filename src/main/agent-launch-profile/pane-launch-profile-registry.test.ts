import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _internals,
  forgetPaneLaunchProfile,
  getPaneLaunchProfile,
  recordPaneLaunchProfileForSpawn
} from './pane-launch-profile-registry'

let userDataPath: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-pane-launch-profile-'))
  process.env.ORCA_USER_DATA_PATH = userDataPath
  _internals.resetCache()
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  _internals.resetCache()
})

describe('pane launch profile registry', () => {
  it('records the profile from the spawn env and survives a re-read', () => {
    recordPaneLaunchProfileForSpawn({
      ptyId: 'pty-1',
      isReattach: false,
      launchEnv: { ORCA_AGENT_LAUNCH_PROFILE: 'codex-secondary-home' }
    })
    _internals.resetCache()
    expect(getPaneLaunchProfile('pty-1')).toBe('codex-secondary-home')
    expect(
      JSON.parse(readFileSync(join(userDataPath, 'agent-launch-profile-panes.json'), 'utf-8'))
    ).toEqual({ version: 1, panes: { 'pty-1': 'codex-secondary-home' } })
  })

  it('keeps a reattached pane on its recorded profile', () => {
    recordPaneLaunchProfileForSpawn({
      ptyId: 'pty-1',
      isReattach: false,
      launchEnv: { ORCA_AGENT_LAUNCH_PROFILE: 'claude-secondary-home' }
    })
    recordPaneLaunchProfileForSpawn({ ptyId: 'pty-1', isReattach: true, launchEnv: {} })
    expect(getPaneLaunchProfile('pty-1')).toBe('claude-secondary-home')
  })

  it('clears a pane that respawns without a profile and forgets exited panes', () => {
    recordPaneLaunchProfileForSpawn({
      ptyId: 'pty-1',
      isReattach: false,
      launchEnv: { ORCA_AGENT_LAUNCH_PROFILE: 'codex-secondary-home' }
    })
    recordPaneLaunchProfileForSpawn({ ptyId: 'pty-1', isReattach: false, launchEnv: {} })
    expect(getPaneLaunchProfile('pty-1')).toBeUndefined()
    recordPaneLaunchProfileForSpawn({
      ptyId: 'pty-2',
      isReattach: false,
      launchEnv: { ORCA_AGENT_LAUNCH_PROFILE: 'codex-secondary-home' }
    })
    forgetPaneLaunchProfile('pty-2')
    expect(getPaneLaunchProfile('pty-2')).toBeUndefined()
    expect(getPaneLaunchProfile(undefined)).toBeUndefined()
  })

  it('ignores a malformed id in the file', () => {
    recordPaneLaunchProfileForSpawn({
      ptyId: 'pty-1',
      isReattach: false,
      launchEnv: { ORCA_AGENT_LAUNCH_PROFILE: 'Not A Slug' }
    })
    expect(getPaneLaunchProfile('pty-1')).toBeUndefined()
  })
})
