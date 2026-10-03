import { afterEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import { buildLocalPreflightEnv } from './preflight-local-env'

// #23214: AppImage/desktop launches can strip HOME and PATH from the process
// environment. Local preflight probes must still find system CLIs and reach the
// user's gh/git credentials, but an inherited value must never be overridden.
const POSIX_FALLBACK_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const savedEnv = { ...process.env }

afterEach(() => {
  if (savedPlatform) {
    Object.defineProperty(process, 'platform', savedPlatform)
  }
  // Why in-place restore and not reassigning process.env: the assignment
  // detaches the env proxy from the native environment, so later os.homedir()
  // calls read a stale native HOME while userInfo().homedir reads passwd.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    process.env[key] = value
  }
})

function withPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

describe('buildLocalPreflightEnv', () => {
  it('leaves a complete posix environment untouched (undefined = inherit)', () => {
    withPlatform('darwin')
    process.env.PATH = '/usr/bin:/bin'
    process.env.HOME = '/Users/tester'
    expect(buildLocalPreflightEnv()).toBeUndefined()
  })

  it('floors PATH when the posix environment has none, preserving HOME', () => {
    withPlatform('linux')
    delete process.env.PATH
    process.env.HOME = '/home/tester'
    const env = buildLocalPreflightEnv()
    expect(env?.PATH).toBe(POSIX_FALLBACK_PATH)
    expect(env?.HOME).toBe('/home/tester')
  })

  it('floors HOME from the passwd-backed homedir when the environment has none', () => {
    withPlatform('linux')
    process.env.PATH = '/usr/bin:/bin'
    delete process.env.HOME
    const env = buildLocalPreflightEnv()
    expect(env?.PATH).toBe('/usr/bin:/bin')
    expect(env?.HOME).toBe(os.userInfo().homedir)
  })

  it('treats empty-string PATH and HOME as missing on posix', () => {
    withPlatform('linux')
    process.env.PATH = ''
    process.env.HOME = ''
    const env = buildLocalPreflightEnv()
    expect(env?.PATH).toBe(POSIX_FALLBACK_PATH)
    // Why userInfo and not os.homedir(): with HOME set-but-empty, os.homedir()
    // answers the empty string verbatim, so the floor must go through passwd.
    expect(env?.HOME).toBe(os.userInfo().homedir)
    expect(env?.HOME).not.toBe('')
  })
})
