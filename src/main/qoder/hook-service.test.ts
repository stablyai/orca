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
import { getManagedLifecycleHook, hasSameManagedHookInvocation } from '../claude/hook-settings'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import { qoderCnHookService, qoderHookService, QODER_HOOK_EVENTS } from './hook-service'
import { markQoderWorkspaceTrusted, withQoderTrustedWorkspace } from './workspace-trust'
import { qwenCodeHookService, QWEN_CODE_HOOK_EVENTS } from '../qwen-code/hook-service'

beforeAll(() => {
  sandbox.home = mkdtempSync(join(tmpdir(), 'orca-qoder-test-'))
  mkdirSync(join(sandbox.home, '.qoder'))
})
afterAll(() => {
  rmSync(sandbox.home, { recursive: true, force: true })
})

describe('Qoder managed configuration', () => {
  it('preserves user hooks and trust, installs idempotently, then removes only Orca hooks', () => {
    const path = join(sandbox.home, '.qoder', 'settings.json')
    const userHook = { hooks: [{ type: 'command', command: 'echo user-hook' }] }
    writeFileSync(
      path,
      JSON.stringify({
        model: 'custom',
        hooks: { Stop: [userHook] },
        permissions: { trustDirectories: ['/existing'] }
      })
    )
    expect(qoderHookService.install().state).toBe('installed')
    expect(qoderHookService.install().state).toBe('installed')
    const installed = JSON.parse(readFileSync(path, 'utf8'))
    for (const event of QODER_HOOK_EVENTS) {
      expect(installed.hooks[event]).toHaveLength(event === 'Stop' ? 2 : 1)
    }
    expect(installed.hooks.TeammateIdle).toBeUndefined()
    expect(installed.statusLine).toBeUndefined()
    markQoderWorkspaceTrusted('/new-workspace', sandbox.home)
    const trusted = JSON.parse(readFileSync(path, 'utf8'))
    expect(trusted.permissions.trustDirectories).toEqual(['/existing', '/new-workspace'])
    expect(trusted.hooks).toEqual(installed.hooks)
    expect(qoderHookService.remove().state).toBe('not_installed')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      model: 'custom',
      hooks: { Stop: [userHook] }
    })
  })

  it("writes every Qoder event whatever Claude version is passed, since Claude's table never applies", () => {
    const path = join(sandbox.home, '.qoder', 'settings.json')
    writeFileSync(path, JSON.stringify({ hooks: {} }))
    expect(qoderHookService.install({ claudeVersion: '1.0.62' }).state).toBe('installed')
    const installed = JSON.parse(readFileSync(path, 'utf8'))
    expect(Object.keys(installed.hooks).sort()).toEqual([...QODER_HOOK_EVENTS].sort())
    expect(installed.statusLine).toBeUndefined()
    expect(qoderHookService.remove().state).toBe('not_installed')
  })

  it('refuses malformed settings instead of overwriting them', () => {
    const path = join(sandbox.home, '.qoder', 'settings.json')
    writeFileSync(path, '{broken')
    expect(qoderHookService.install().state).toBe('error')
    markQoderWorkspaceTrusted('/new-workspace', sandbox.home)
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    expect(withQoderTrustedWorkspace({ permissions: 'invalid' }, '/workspace')).toBeNull()
    expect(
      withQoderTrustedWorkspace({ permissions: { trustDirectories: true } }, '/workspace')
    ).toBeNull()
  })
})

describe('Qoder Windows hook shell', () => {
  it('uses the documented explicit shell without relying on Git Bash or another PowerShell hop', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const hook = getManagedLifecycleHook('C:\\Users\\a b\\.orca\\agent-hooks\\qoder-hook.cmd', {
        configDirName: '.qoder',
        scriptBaseName: 'qoder-hook',
        usesWindowsCompatLauncher: true,
        windowsHookShell: 'powershell'
      })
      expect(hook.shell).toBe('powershell')
      expect(hook.command).toContain('$env:USERPROFILE')
      expect(hook.command).not.toMatch(/EncodedCommand|ExecutionPolicy|\|\|/)
      expect(createManagedCommandMatcher('qoder-hook.cmd')(hook.command)).toBe(true)
      expect(hasSameManagedHookInvocation({ ...hook, shell: undefined }, hook)).toBe(false)
    } finally {
      vi.restoreAllMocks()
    }
  })
})

it.each([
  {
    service: qoderCnHookService,
    directory: '.qoder-cn',
    source: 'qoder-cn',
    events: QODER_HOOK_EVENTS
  },
  {
    service: qwenCodeHookService,
    directory: '.qwen',
    source: 'qwen-code',
    events: QWEN_CODE_HOOK_EVENTS
  }
])(
  'installs and removes $source hooks without changing user settings',
  ({ service, directory, source, events }) => {
    const configDir = join(sandbox.home, directory)
    mkdirSync(configDir, { recursive: true })
    const path = join(configDir, 'settings.json')
    const userHook = { matcher: '', hooks: [{ type: 'command', command: 'echo user-owned' }] }
    writeFileSync(
      path,
      JSON.stringify({
        model: 'custom',
        statusLine: { command: 'user-status' },
        hooks: { Stop: [userHook] }
      })
    )
    expect(service.install().state).toBe('installed')
    const installed = JSON.parse(readFileSync(path, 'utf8'))
    expect(Object.keys(installed.hooks).sort()).toEqual([...events].sort())
    expect(installed.statusLine).toEqual({ command: 'user-status' })
    expect(
      readFileSync(join(sandbox.home, '.orca', 'agent-hooks', `${source}-hook.sh`), 'utf8')
    ).toContain(`/hook/${source}`)
    if (source === 'qoder-cn') {
      markQoderWorkspaceTrusted('/cn-workspace', sandbox.home, '.qoder-cn')
      expect(JSON.parse(readFileSync(path, 'utf8')).permissions.trustDirectories).toEqual([
        '/cn-workspace'
      ])
    }
    expect(service.remove().state).toBe('not_installed')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      model: 'custom',
      hooks: { Stop: [userHook] }
    })
  }
)
