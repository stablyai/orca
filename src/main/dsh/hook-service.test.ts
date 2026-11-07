import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DshHookService } from './hook-service'

// Redirect HOME and USERPROFILE and clear DSH_HOME so tests cannot edit real user config.
let home: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalDshHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-dsh-hook-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  originalDshHome = process.env.DSH_HOME
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.DSH_HOME
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalUserProfile
  }
  if (originalDshHome === undefined) {
    delete process.env.DSH_HOME
  } else {
    process.env.DSH_HOME = originalDshHome
  }
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.dsh', 'cordis.patch.yml')
const managedHooksPath = (): string => join(home, '.orca', 'agent-hooks', 'dsh-hooks.json')

function readManagedHooks(): { hooks: Record<string, unknown[]> } {
  const parsed: { hooks: Record<string, unknown[]> } = JSON.parse(
    readFileSync(managedHooksPath(), 'utf-8')
  )
  return parsed
}

describe('DshHookService', () => {
  it('preserves an existing user patch layer through install and remove', () => {
    const userRows = ['- id: llm-deepseek', '  config:', '    thinking: disabled', ''].join('\n')
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(configPath(), userRows, 'utf-8')

    const service = new DshHookService()
    expect(service.install().state).toBe('installed')
    expect(readFileSync(configPath(), 'utf-8')).toContain('thinking: disabled')

    expect(service.remove().state).toBe('not_installed')
    expect(readFileSync(configPath(), 'utf-8').trimEnd()).toBe(userRows.trimEnd())
  })

  it('removes the managed hooks file along with the block', () => {
    const service = new DshHookService()
    service.install()
    service.remove()
    expect(() => readFileSync(managedHooksPath(), 'utf-8')).toThrow()
    expect(service.getStatus().state).toBe('not_installed')
  })

  it('reports partial when an event loses its managed hook', () => {
    const service = new DshHookService()
    service.install()
    const managed = readManagedHooks()
    delete managed.hooks.Stop
    writeFileSync(managedHooksPath(), JSON.stringify(managed, null, 2), 'utf-8')

    const status = service.getStatus()
    expect(status.state).toBe('partial')
    expect(status.detail).toContain('Stop')
  })

  it('reports partial until every DSH profile carries the packages the row imports', () => {
    const profileDir = (name: string): string => join(home, '.dsh', 'profiles', name)
    const addPackage = (profile: string, pkg: string): void => {
      const dir = join(profileDir(profile), 'node_modules', ...pkg.split('/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), '{}', 'utf-8')
    }
    for (const profile of ['headless', 'web']) {
      mkdirSync(profileDir(profile), { recursive: true })
      writeFileSync(join(profileDir(profile), 'package.json'), '{}', 'utf-8')
    }
    addPackage('web', '@deepseek-ai/dsh-hooks-claude-code')

    const service = new DshHookService()
    const status = service.install()
    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toContain(
      `${profileDir('headless')} (missing @deepseek-ai/dsh-hooks-claude-code, @deepseek-ai/dsh-hook-protocol)`
    )
    expect(status.detail).toContain(`${profileDir('web')} (missing @deepseek-ai/dsh-hook-protocol)`)

    for (const profile of ['headless', 'web']) {
      addPackage(profile, '@deepseek-ai/dsh-hooks-claude-code')
      addPackage(profile, '@deepseek-ai/dsh-hook-protocol')
    }
    expect(service.getStatus()).toMatchObject({ state: 'installed', detail: null })
  })

  it('reports not_installed when the block points somewhere else', () => {
    const service = new DshHookService()
    service.install()
    writeFileSync(
      configPath(),
      readFileSync(configPath(), 'utf-8').replace(managedHooksPath(), '/somewhere/else.json'),
      'utf-8'
    )
    const status = service.getStatus()
    expect(status.state).toBe('not_installed')
    expect(status.detail).toContain('/somewhere/else.json')
  })

  // Windows chmod controls read-only state rather than POSIX permission bits.
  it.skipIf(process.platform === 'win32')('keeps an owner-only patch file owner-only', () => {
    const userRows = '- id: llm-deepseek\n  config: {}\n'
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(configPath(), userRows, 'utf-8')
    chmodSync(configPath(), 0o600)

    expect(new DshHookService().install().state).toBe('installed')
    expect(statSync(configPath()).mode & 0o777).toBe(0o600)
  })

  it('refuses a flow-style patch file instead of corrupting it', () => {
    const flow = '[{ id: llm-deepseek }]\n'
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(configPath(), flow, 'utf-8')

    const service = new DshHookService()
    const installed = service.install()
    expect(installed.state).toBe('error')
    expect(installed.detail).toContain('flow-style sequence')
    expect(readFileSync(configPath(), 'utf-8')).toBe(flow)

    const polled = service.getStatus()
    expect(polled.state).toBe('error')
    expect(polled.detail).toContain('flow-style sequence')
  })
})
