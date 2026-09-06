import { afterEach, describe, expect, it } from 'vitest'
import { delimiter } from 'node:path'
import {
  _resetHydrateShellPathCache,
  _setLaunchPathForTests
} from '../../../startup/hydrate-shell-path'
import { readInheritedPath, restoreLauncherInheritedPath } from './path'

const LAUNCH_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)
const SEEDED_TAIL = [
  '/opt/homebrew/bin',
  '/Users/me/.local/share/mise/shims',
  '/Users/me/.volta/bin'
].join(delimiter)

describe('restoreLauncherInheritedPath', () => {
  const inheritedProcessPath = process.env.PATH

  afterEach(() => {
    _resetHydrateShellPathCache()
    if (inheritedProcessPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = inheritedProcessPath
    }
  })

  it.skipIf(process.platform === 'win32')(
    'hands the pane the launcher PATH instead of the seeded one',
    () => {
      _setLaunchPathForTests(LAUNCH_PATH)
      process.env.PATH = `${LAUNCH_PATH}${delimiter}${SEEDED_TAIL}`
      const env = { PATH: process.env.PATH }

      restoreLauncherInheritedPath(env)

      expect(env.PATH).toBe(LAUNCH_PATH)
    }
  )

  it.skipIf(process.platform === 'win32')('fills in a pane env that carries no PATH', () => {
    _setLaunchPathForTests(LAUNCH_PATH)
    process.env.PATH = `${LAUNCH_PATH}${delimiter}${SEEDED_TAIL}`
    const env: Record<string, string> = {}

    restoreLauncherInheritedPath(env)

    expect(readInheritedPath(env)).toBe(LAUNCH_PATH)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a prefix the caller prepended onto the seeded PATH',
    () => {
      _setLaunchPathForTests(LAUNCH_PATH)
      process.env.PATH = `${LAUNCH_PATH}${delimiter}${SEEDED_TAIL}`
      const env = { PATH: `/agent-teams-shim${delimiter}${process.env.PATH}` }

      restoreLauncherInheritedPath(env)

      expect(env.PATH).toBe(`/agent-teams-shim${delimiter}${LAUNCH_PATH}`)
    }
  )

  it.skipIf(process.platform === 'win32')('leaves a PATH the caller composed itself alone', () => {
    _setLaunchPathForTests(LAUNCH_PATH)
    process.env.PATH = `${LAUNCH_PATH}${delimiter}${SEEDED_TAIL}`
    const env = { PATH: `/tmp/hijack-scratch${delimiter}/usr/bin` }

    restoreLauncherInheritedPath(env)

    expect(env.PATH).toBe(`/tmp/hijack-scratch${delimiter}/usr/bin`)
  })

  it.skipIf(process.platform !== 'win32')('never rewrites PATH on Windows', () => {
    _setLaunchPathForTests('C:\\Windows\\system32', 'Path')
    const env: Record<string, string> = { Path: 'C:\\Orca\\bin;C:\\Windows\\system32' }

    restoreLauncherInheritedPath(env)

    expect(env.Path).toBe('C:\\Orca\\bin;C:\\Windows\\system32')
    expect(env.PATH).toBeUndefined()
  })
})
