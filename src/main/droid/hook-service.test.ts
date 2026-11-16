import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'
import { removeTreeSync } from '../../shared/file-write/windows-transient-lock-removal'

const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => hoisted.home }
})

import { DroidHookService } from './hook-service'
import { eventEntries, parseJsonObject } from './droid-hooks-file.test-fixture'

const userHook = { hooks: [{ type: 'command', command: 'echo user-hook' }] }

describe('DroidHookService', () => {
  let root: string
  let service: DroidHookService
  let hooksPath: string
  let settingsPath: string
  let orgPath: string

  const read = (path: string) => parseJsonObject(readFileSync(path, 'utf8'))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-droid-home-'))
    hoisted.home = join(root, 'home')
    hooksPath = join(hoisted.home, '.factory', 'hooks.json')
    settingsPath = join(hoisted.home, '.factory', 'settings.json')
    orgPath = join(root, 'org.json')
    service = new DroidHookService({ orgSettingsPath: orgPath })
  })

  afterEach(() => {
    removeTreeSync(root)
  })

  it('migrates only managed entries and retains user hooks and unrelated settings', () => {
    const original =
      '{"disabledSkills":["pdf"],"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo user-hook"}]}],"Stop":[{"hooks":[{"type":"command","command":"echo user-hook"}]},{"hooks":[{"command":"/old/.orca/agent-hooks/droid-hook.sh"}]}]}}\n'
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, original)

    expect(service.install()).toMatchObject({
      state: 'installed',
      configPath: hooksPath,
      managedHooksPresent: true
    })
    const hooks = read(hooksPath)
    expect(hooks.hooks).toBeUndefined()
    expect(eventEntries(hooks, 'Stop')).toHaveLength(2)
    expect(eventEntries(hooks, 'Stop')[0]).toEqual(userHook)
    expect(eventEntries(hooks, 'SessionStart')[0]).toEqual(userHook)
    expect(read(settingsPath)).toEqual({
      disabledSkills: ['pdf'],
      hooks: { SessionStart: [userHook], Stop: [userHook] }
    })
    expect(readFileSync(`${settingsPath}.bak`, 'utf8')).toBe(original)

    expect(service.remove().managedHooksPresent).toBe(false)
    expect(eventEntries(read(hooksPath), 'Stop')).toEqual([userHook])
    expect(read(settingsPath).disabledSkills).toEqual(['pdf'])
  })

  it('preserves the last recoverable backup on an unchanged reinstall', () => {
    const original = '{"Stop":[{"hooks":[{"type":"command","command":"echo user-hook"}]}]}\n'
    mkdirSync(dirname(hooksPath), { recursive: true })
    writeFileSync(hooksPath, original)

    service.install()
    service.install()

    expect(readFileSync(`${hooksPath}.bak`, 'utf8')).toBe(original)
    expect(service.remove().managedHooksPresent).toBe(false)
    service.remove()
    expect(read(hooksPath)).toEqual({ Stop: [userHook] })
  })

  it.each(['hooks.json', 'settings.json'])(
    'refuses malformed %s before writing a script',
    (file) => {
      const path = join(hoisted.home, '.factory', file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '{invalid')

      expect(service.install()).toMatchObject({ state: 'error', configPath: hooksPath })
      expect(readFileSync(path, 'utf8')).toBe('{invalid')
      expect(existsSync(join(hoisted.home, '.orca', 'agent-hooks', 'droid-hook.sh'))).toBe(false)
      expect(existsSync(join(hoisted.home, '.orca', 'agent-hooks', 'droid-hook.cmd'))).toBe(false)
    }
  )
})
