import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const deleteRace = vi.hoisted((): { path: string | null; code: string } => ({
  path: null,
  code: 'ENOENT'
}))

// Why: simulates the config file (or an ancestor directory) vanishing between
// writeConfigToml's existsSync check and its statSync mode read — e.g. a
// concurrent uninstall, user delete, or a directory replaced by a file.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const statSync = (
    target: NodeFs.PathLike,
    options?: NodeFs.StatSyncOptions
  ): NodeFs.Stats | NodeFs.BigIntStats | undefined => {
    if (typeof target === 'string' && target === deleteRace.path) {
      throw Object.assign(new Error(`${deleteRace.code}: simulated race`), {
        code: deleteRace.code
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarding actual.statSync's own overload signature.
    return actual.statSync(target, options as NodeFs.StatSyncOptions)
  }
  const patched = { ...actual, statSync }
  return { ...patched, default: patched }
})

const fs = await vi.importActual<typeof NodeFs>('node:fs')
const { KimiHookService } = await import('./hook-service')
const { KIMI_HOOK_EVENTS } = await import('./kimi-hook-config-toml')

let home: string
let originalHome: string | undefined
let originalKimiHome: string | undefined
let originalUserProfile: string | undefined

const configPath = (): string => join(home, '.kimi-code', 'config.toml')

beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'orca-kimi-hook-delete-race-'))
  originalHome = process.env.HOME
  originalKimiHome = process.env.KIMI_CODE_HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.KIMI_CODE_HOME = join(home, '.kimi-code')
  process.env.USERPROFILE = home
})

afterEach(() => {
  deleteRace.path = null
  deleteRace.code = 'ENOENT'
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
  fs.rmSync(home, { recursive: true, force: true })
})

describe('KimiHookService config delete race', () => {
  it.each(['ENOENT', 'ENOTDIR'])(
    'still writes the config when the mode stat fails with %s',
    (code) => {
      fs.mkdirSync(join(home, '.kimi-code'), { recursive: true })
      fs.writeFileSync(configPath(), 'api_key = "fixture-only"\n')
      deleteRace.path = configPath()
      deleteRace.code = code

      expect(() => new KimiHookService().install()).not.toThrow()

      const config = fs.readFileSync(configPath(), 'utf-8')
      for (const event of KIMI_HOOK_EVENTS) {
        expect(config).toContain(`event = "${event}"`)
      }
    }
  )
})
