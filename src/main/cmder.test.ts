import { describe, expect, it } from 'vitest'
import {
  applyCmderSpawnEnvironment,
  applyConfiguredCmderRootEnv,
  setConfiguredCmderRoot,
  getCmderRootCandidates,
  resolveCmderRoot,
  resolveWindowsCmderShellRoot
} from './cmder'

describe('Cmder discovery', () => {
  it('prefers CMDER_ROOT and strips quotes and trailing separators', () => {
    const candidates = getCmderRootCandidates({
      CMDER_ROOT: '"C:\\programs\\cmder\\"',
      USERPROFILE: 'C:\\Users\\alice'
    })
    expect(candidates[0]).toBe('C:\\programs\\cmder')
    expect(candidates).toContain('C:\\Users\\alice\\scoop\\apps\\cmder\\current')
  })

  it('resolves the first root whose vendor init.bat exists', () => {
    expect(
      resolveCmderRoot({
        platform: 'win32',
        env: { CMDER_ROOT: 'D:\\missing', USERPROFILE: 'C:\\Users\\alice' },
        exists: (path) => path === 'C:\\Users\\alice\\cmder\\vendor\\init.bat'
      })
    ).toBe('C:\\Users\\alice\\cmder')
  })

  it('never resolves off Windows', () => {
    expect(
      resolveCmderRoot({ platform: 'linux', env: { CMDER_ROOT: 'C:\\cmder' }, exists: () => true })
    ).toBeNull()
  })

  it('only maps the cmder sentinel', () => {
    const options = {
      platform: 'win32' as const,
      env: { CMDER_ROOT: 'C:\\cmder' },
      exists: () => true
    }
    expect(resolveWindowsCmderShellRoot('Cmder', options)).toBe('C:\\cmder')
    expect(resolveWindowsCmderShellRoot('cmd.exe', options)).toBeNull()
  })

  it('sets CMDER_ROOT and the init path/quote pair, dropping inherited init state', () => {
    const env: Record<string, string> = {
      CMDER_CONFIGURED: '2',
      CMDER_INIT_START: '1:00',
      CMDER_INIT_END: '1:01'
    }
    applyCmderSpawnEnvironment(env, 'C:\\Program Files\\cmder')
    expect(env).toEqual({
      CMDER_ROOT: 'C:\\Program Files\\cmder',
      ORCA_CMDER_INIT: 'C:\\Program Files\\cmder\\vendor\\init.bat',
      ORCA_CMDER_INIT_QUOTE: '"'
    })
  })

  it('ranks the spawn-carried setting over CMDER_ROOT, and the main-process setting next', () => {
    expect(
      getCmderRootCandidates({ ORCA_CMDER_ROOT: 'D:\\cmder', CMDER_ROOT: 'C:\\cmder' }).slice(0, 2)
    ).toEqual(['D:\\cmder', 'C:\\cmder'])
    setConfiguredCmderRoot('  E:\\apps\\cmder  ')
    try {
      expect(getCmderRootCandidates({ CMDER_ROOT: 'C:\\cmder' })[0]).toBe('E:\\apps\\cmder')
    } finally {
      setConfiguredCmderRoot(null)
    }
  })

  it('carries only a non-empty setting into spawn env', () => {
    const options: { env?: Record<string, string> } = { env: { PATH: 'x' } }
    applyConfiguredCmderRootEnv(options, '   ')
    expect(options.env).toEqual({ PATH: 'x' })
    applyConfiguredCmderRootEnv(options, 'D:\\cmder')
    expect(options.env).toEqual({ PATH: 'x', ORCA_CMDER_ROOT: 'D:\\cmder' })
    applyConfiguredCmderRootEnv(options, '')
    expect(options.env).toEqual({ PATH: 'x' })
  })
})
