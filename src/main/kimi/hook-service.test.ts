import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KimiHookService } from './hook-service'

// Isolate homedir (HOME/USERPROFILE) and KIMI_CODE_HOME so installs cannot touch real configs.
let home: string
let originalHome: string | undefined
let originalKimiHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-kimi-hook-'))
  originalHome = process.env.HOME
  originalKimiHome = process.env.KIMI_CODE_HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.KIMI_CODE_HOME = join(home, '.kimi-code')
  process.env.USERPROFILE = home
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalKimiHome === undefined) {
    delete process.env.KIMI_CODE_HOME
  } else {
    process.env.KIMI_CODE_HOME = originalKimiHome
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalUserProfile
  }
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.kimi-code', 'config.toml')
const supportsPosixFileModes = process.platform !== 'win32'

describe('KimiHookService', () => {
  it.skipIf(!supportsPosixFileModes)(
    'preserves an existing config mode while installing and removing hooks',
    () => {
      mkdirSync(join(home, '.kimi-code'), { recursive: true })
      writeFileSync(configPath(), 'api_key = "sk-secret"\n')
      const existingMode = 0o640
      chmodSync(configPath(), existingMode)

      const service = new KimiHookService()
      const originalUmask = process.umask(0o077)
      try {
        service.install()
        expect(statSync(configPath()).mode & 0o777).toBe(existingMode)
        expect(statSync(`${configPath()}.bak`).mode & 0o777).toBe(existingMode)
        expect(
          readdirSync(join(home, '.kimi-code')).filter((name) => name.endsWith('.tmp'))
        ).toEqual([])

        service.remove()
        expect(statSync(configPath()).mode & 0o777).toBe(existingMode)
      } finally {
        process.umask(originalUmask)
      }
    }
  )

  it.skipIf(!supportsPosixFileModes)('creates a new config with an owner-only mode', () => {
    const originalUmask = process.umask(0o022)
    try {
      new KimiHookService().install()

      expect(statSync(configPath()).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(originalUmask)
    }
  })
})
