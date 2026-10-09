import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as OsModule from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
const sandbox = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof OsModule>()),
  homedir: () => sandbox.home
}))
vi.mock('electron', () => ({ app: { getPath: () => sandbox.home } }))
import { codebuddyHookService, CODEBUDDY_HOOK_EVENTS } from './hook-service'

beforeAll(() => {
  sandbox.home = mkdtempSync(join(tmpdir(), 'orca-codebuddy-test-'))
  mkdirSync(join(sandbox.home, '.codebuddy'))
})
afterAll(() => rmSync(sandbox.home, { recursive: true, force: true }))

describe('CodeBuddy managed hooks', () => {
  it('preserves user configuration through repeated install and removal', () => {
    const path = join(sandbox.home, '.codebuddy', 'settings.json')
    const userHook = { hooks: [{ type: 'command', command: 'echo user-hook' }] }
    const settings = {
      model: 'custom',
      hooks: { Stop: [userHook] },
      statusLine: { command: 'user-status' }
    }
    writeFileSync(path, JSON.stringify(settings))
    expect(codebuddyHookService.install().state).toBe('installed')
    expect(codebuddyHookService.install().state).toBe('installed')
    const installed = JSON.parse(readFileSync(path, 'utf8'))
    for (const event of CODEBUDDY_HOOK_EVENTS) {
      expect(installed.hooks[event]).toHaveLength(event === 'Stop' ? 2 : 1)
    }
    expect(installed.statusLine).toEqual(settings.statusLine)
    expect(codebuddyHookService.remove().state).toBe('not_installed')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(settings)
  })

  it('leaves malformed user settings untouched', () => {
    const path = join(sandbox.home, '.codebuddy', 'settings.json')
    writeFileSync(path, '{broken')
    expect(codebuddyHookService.install().state).toBe('error')
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })
})
