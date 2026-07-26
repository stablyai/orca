import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActiveViewPreference, getActiveViewPreferenceFile } from './active-view-preference'

describe('ActiveViewPreference', () => {
  let dir: string
  let dataFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-active-view-'))
    dataFile = join(dir, 'orca-data.json')
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('migrates the legacy durable-state value into the profile sidecar', async () => {
    vi.useFakeTimers()
    const preference = new ActiveViewPreference(dataFile, 'tasks')

    expect(preference.get()).toBe('tasks')
    expect(existsSync(getActiveViewPreferenceFile(dataFile))).toBe(false)

    // The renderer reasserts its hydrated value once persistence is ready.
    expect(preference.set('tasks')).toBe(false)
    vi.advanceTimersByTime(100)
    await preference.waitForPendingWrite()

    expect(JSON.parse(readFileSync(getActiveViewPreferenceFile(dataFile), 'utf-8'))).toEqual({
      activeView: 'tasks'
    })
  })

  it('coalesces rapid switches into one tiny preference write', async () => {
    vi.useFakeTimers()
    const preference = new ActiveViewPreference(dataFile, 'terminal')

    preference.set('settings')
    vi.advanceTimersByTime(50)
    preference.set('automations')
    vi.advanceTimersByTime(50)
    expect(existsSync(getActiveViewPreferenceFile(dataFile))).toBe(false)

    vi.advanceTimersByTime(50)
    await preference.waitForPendingWrite()

    expect(JSON.parse(readFileSync(getActiveViewPreferenceFile(dataFile), 'utf-8'))).toEqual({
      activeView: 'automations'
    })
  })

  it('flushes synchronously for an immediate graceful exit', () => {
    vi.useFakeTimers()
    const preference = new ActiveViewPreference(dataFile, 'terminal')

    preference.set('settings')
    preference.flushOrThrow()

    expect(JSON.parse(readFileSync(getActiveViewPreferenceFile(dataFile), 'utf-8'))).toEqual({
      activeView: 'settings'
    })
    vi.advanceTimersByTime(100)
    expect(JSON.parse(readFileSync(getActiveViewPreferenceFile(dataFile), 'utf-8'))).toEqual({
      activeView: 'settings'
    })
  })

  it('ignores an invalid sidecar and invalid updates', () => {
    writeFileSync(getActiveViewPreferenceFile(dataFile), '{"activeView":"unknown"}', 'utf-8')
    const preference = new ActiveViewPreference(dataFile, 'not-a-view')

    expect(preference.get()).toBe('terminal')
    expect(preference.set('also-not-a-view')).toBe(false)
    expect(preference.get()).toBe('terminal')
  })

  it('rejects inherited object keys from a corrupt sidecar', () => {
    // Why: `constructor`/`__proto__` are truthy under `in`; the sidecar must not
    // treat them as a valid view and leave the main surface blank.
    writeFileSync(getActiveViewPreferenceFile(dataFile), '{"activeView":"constructor"}', 'utf-8')
    const preference = new ActiveViewPreference(dataFile, 'tasks')

    expect(preference.get()).toBe('tasks')
    expect(preference.set('__proto__')).toBe(false)
    expect(preference.get()).toBe('tasks')
  })
})
