import { describe, expect, it } from 'vitest'
import { buildFilesystemHostEnv } from './filesystem-host-env'

describe('buildFilesystemHostEnv', () => {
  it('passes only plain-Node runtime necessities', () => {
    const env = buildFilesystemHostEnv({
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\secret\\AppData\\Local',
      TEMP: 'C:\\Temp',
      HOME: '/secret/home',
      USERPROFILE: 'C:\\Users\\secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      NODE_OPTIONS: '--inspect',
      UV_THREADPOOL_SIZE: '99',
      ORCA_BUILD_IDENTITY: 'rc'
    })

    expect(env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\secret\\AppData\\Local',
      TEMP: 'C:\\Temp'
    })
  })
})
