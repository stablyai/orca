import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { selectAppProfile } from './app-profile-selection'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-app-profiles-'))
  const appPath = join(root, 'Work.app')
  const app = (path: string, extra: string): void => {
    mkdirSync(join(path, 'Contents'), { recursive: true })
    writeFileSync(
      join(path, 'Contents', 'Info.plist'),
      `<dict><key>CFBundleExecutable</key>\n<string>Orca</string>${extra}</dict>`
    )
  }
  app(appPath, '<key>OrcaAppProfileId</key><string>work</string>')
  app(join(root, 'Default.app'), '')
  mkdirSync(join(root, 'work'))
  writeFileSync(join(root, 'work', 'orca-app-profile.json'), '{"id":"work"}')
  writeFileSync(
    join(root, 'profiles.json'),
    JSON.stringify({
      version: 1,
      defaultAppPath: join(root, 'Default.app'),
      profiles: [{ id: 'work', appPath, userDataPath: join(root, 'work') }]
    })
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('selectAppProfile', () => {
  it('removes --profile before the command and points the CLI at the profile', () => {
    const env: NodeJS.ProcessEnv = { ORCA_PROFILES_ROOT: root }
    expect(selectAppProfile(['--profile', 'work', 'chat', 'list'], env)).toEqual(['chat', 'list'])
    expect(env.ORCA_USER_DATA_PATH).toBe(join(root, 'work'))
    expect(env.ORCA_APP_EXECUTABLE).toBe(join(root, 'Work.app', 'Contents', 'MacOS', 'Orca'))
  })

  it("gives the command the profile's own home folders, and none for the default", () => {
    const env: NodeJS.ProcessEnv = { ORCA_PROFILES_ROOT: root }
    selectAppProfile(['--profile', 'work', 'serve'], env)
    expect(env.ORCA_HOME_DIR).toBe(join(root, 'work', 'orca-home'))
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, 'work', 'orca-home', 'agents', 'claude'))
    expect(env.CODEX_HOME).toBe(join(root, 'work', 'orca-home', 'agents', 'codex'))
    selectAppProfile(['--profile', 'default', 'serve'], env)
    expect(env.ORCA_HOME_DIR).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('keeps a --profile after the command for the browser', () => {
    const env: NodeJS.ProcessEnv = { ORCA_PROFILES_ROOT: root }
    const argv = ['tab', 'open', '--profile', 'x']
    expect(selectAppProfile(argv, env)).toEqual(argv)
    expect(env.ORCA_USER_DATA_PATH).toBeUndefined()
  })

  it('uses ORCA_PROFILE, and --profile=<id> wins over it', () => {
    const env: NodeJS.ProcessEnv = { ORCA_PROFILES_ROOT: root, ORCA_PROFILE: 'work' }
    expect(selectAppProfile(['status'], env)).toEqual(['status'])
    expect(env.ORCA_USER_DATA_PATH).toBe(join(root, 'work'))
    expect(selectAppProfile(['--profile=default', 'status'], env)).toEqual(['status'])
    expect(env.ORCA_USER_DATA_PATH).toBeUndefined()
    expect(env.ORCA_APP_EXECUTABLE).toBe(join(root, 'Default.app', 'Contents', 'MacOS', 'Orca'))
  })

  it("never runs a profile's bundle for another folder", () => {
    const workExecutable = join(root, 'Work.app', 'Contents', 'MacOS', 'Orca')
    // `orca --profile default serve` in a Work terminal serves the default folder with the default app.
    const fromWork: NodeJS.ProcessEnv = {
      ORCA_PROFILES_ROOT: root,
      ORCA_USER_DATA_PATH: join(root, 'work'),
      ORCA_APP_EXECUTABLE: workExecutable
    }
    selectAppProfile(['--profile', 'default', 'serve'], fromWork)
    expect(fromWork.ORCA_APP_EXECUTABLE).toBe(
      join(root, 'Default.app', 'Contents', 'MacOS', 'Orca')
    )
    // An inherited profile executable is dropped for a folder that is not that profile's.
    const other: NodeJS.ProcessEnv = {
      ORCA_USER_DATA_PATH: join(root, 'other'),
      ORCA_APP_EXECUTABLE: workExecutable
    }
    selectAppProfile(['serve'], other)
    expect(other.ORCA_APP_EXECUTABLE).toBeUndefined()
  })

  it('keeps an inherited executable that is not a profile app, such as the dev launcher', () => {
    const electron = join(root, 'Electron.app')
    mkdirSync(join(electron, 'Contents'), { recursive: true })
    writeFileSync(
      join(electron, 'Contents', 'Info.plist'),
      '<dict><key>CFBundleExecutable</key>\n<string>Electron</string></dict>'
    )
    const executable = join(electron, 'Contents', 'MacOS', 'Electron')
    const env: NodeJS.ProcessEnv = {
      ORCA_USER_DATA_PATH: join(root, 'orca-dev'),
      ORCA_APP_EXECUTABLE: executable
    }
    selectAppProfile(['serve'], env)
    expect(env.ORCA_APP_EXECUTABLE).toBe(executable)
  })

  it('finds the executable from the marker of an inherited ORCA_USER_DATA_PATH', () => {
    // A profile terminal or the serve LaunchAgent has no ORCA_PROFILES_ROOT.
    const env: NodeJS.ProcessEnv = { ORCA_USER_DATA_PATH: join(root, 'work') }
    selectAppProfile(['serve'], env)
    expect(env.ORCA_APP_EXECUTABLE).toBe(join(root, 'Work.app', 'Contents', 'MacOS', 'Orca'))
  })
})
