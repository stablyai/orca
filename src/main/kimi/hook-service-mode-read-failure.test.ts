import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const modeReadFailure = vi.hoisted(() => ({ path: null as string | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const statSync = ((target: unknown, ...args: unknown[]) => {
    if (typeof target === 'string' && target === modeReadFailure.path) {
      throw new Error('mode unavailable')
    }
    return (actual.statSync as (...parameters: unknown[]) => unknown)(target, ...args)
  }) as typeof actual.statSync
  const patched = { ...actual, statSync }
  return { ...patched, default: patched }
})

const fs = await vi.importActual<typeof NodeFs>('node:fs')
const { KimiHookService } = await import('./hook-service')

let home: string
let originalHome: string | undefined
let originalKimiHome: string | undefined
let originalUserProfile: string | undefined

const configPath = (): string => join(home, '.kimi-code', 'config.toml')

beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'orca-kimi-hook-mode-read-'))
  originalHome = process.env.HOME
  originalKimiHome = process.env.KIMI_CODE_HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.KIMI_CODE_HOME = join(home, '.kimi-code')
  process.env.USERPROFILE = home
})

afterEach(() => {
  modeReadFailure.path = null
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

describe('KimiHookService config mode preservation', () => {
  it('does not replace an existing config when its mode cannot be read', () => {
    fs.mkdirSync(join(home, '.kimi-code'), { recursive: true })
    const original = 'api_key = "sk-secret"\n'
    fs.writeFileSync(configPath(), original)
    modeReadFailure.path = configPath()

    expect(() => new KimiHookService().install()).toThrow('mode unavailable')
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(original)
  })
})
