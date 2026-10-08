import { afterEach, describe, expect, it } from 'vitest'
import {
  getAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../../shared/app-environment'

const fallbackEnvironment: AppEnvironment = {
  getPath: (name) => (name === 'userData' ? '/tmp/orca-serve-settings-default' : '/tmp'),
  getAppPath: () => '/tmp',
  getVersion: () => '0.0.0-test',
  isPackaged: () => false,
  onWillQuit: () => () => {},
  exit: () => {},
  getAppMetrics: () => []
}

let previousEnvironment: AppEnvironment | null = null
try {
  previousEnvironment = getAppEnvironment()
} catch {
  setAppEnvironment(fallbackEnvironment)
  previousEnvironment = fallbackEnvironment
}

const {
  setServeBrowserSettingsResolver,
  resolveServeBrowserPaintMode,
  resolveServeBrowserIdleSleepSeconds
} = await import('./serve-browser-settings')

function environmentWithUserDataPath(userDataPath: string): AppEnvironment {
  const base = previousEnvironment
  if (!base) {
    throw new Error('no base environment')
  }
  return {
    ...base,
    getPath: (name) => (name === 'userData' ? userDataPath : base.getPath(name))
  }
}

describe('serve-browser-settings', () => {
  afterEach(() => {
    setServeBrowserSettingsResolver(() => undefined)
    setAppEnvironment(previousEnvironment)
  })

  it('applies defaults when no settings are available', () => {
    // Why {}: an undefined result triggers the one-shot persisted-file read, whose cached
    // value the fallback test below depends on reading first.
    setServeBrowserSettingsResolver(() => ({}))
    expect(resolveServeBrowserPaintMode()).toBe('auto')
    expect(resolveServeBrowserIdleSleepSeconds()).toBe(600)
  })

  it('reads values from the injected live settings resolver', () => {
    setServeBrowserSettingsResolver(() => ({
      serveBrowserPaintMode: 'always',
      serveBrowserIdleSleepSeconds: 0
    }))
    expect(resolveServeBrowserPaintMode()).toBe('always')
    expect(resolveServeBrowserIdleSleepSeconds()).toBe(0)
  })

  it('rejects invalid persisted values', () => {
    setServeBrowserSettingsResolver(() => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: intentionally invalid persisted value to exercise the resolver fallback.
      serveBrowserPaintMode: 'sometimes' as never,
      serveBrowserIdleSleepSeconds: -5
    }))
    expect(resolveServeBrowserPaintMode()).toBe('auto')
    expect(resolveServeBrowserIdleSleepSeconds()).toBe(600)
  })

  it('falls back to the persisted file when no resolver is set', async () => {
    const { writeFile, mkdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const userDataDir = join(tmpdir(), 'orca-serve-settings-test')
    setAppEnvironment(environmentWithUserDataPath(userDataDir))
    await mkdir(userDataDir, { recursive: true })
    await writeFile(
      join(userDataDir, 'orca-data.json'),
      JSON.stringify({ settings: { serveBrowserPaintMode: 'always' } })
    )
    try {
      // First call triggers the cached persisted read.
      expect(resolveServeBrowserPaintMode()).toBe('always')
      expect(resolveServeBrowserIdleSleepSeconds()).toBe(600)
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  })
})
