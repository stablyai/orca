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
import { DSH_HOOK_EVENTS } from './hook-settings'

// Why: getSharedManagedScriptPath() writes under homedir()/.orca and the patch layer
// resolves via DSH_HOME ?? ~/.dsh. Point the home env at a temp dir and clear DSH_HOME so
// install/remove never touches the real ~/.orca or a developer's own DSH home.
// Why both names: os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows, and this
// file asserts the Windows script name too — setting only HOME would let a Windows run edit
// the developer's real home.
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
const scriptPath = (): string =>
  join(home, '.orca', 'agent-hooks', process.platform === 'win32' ? 'dsh-hook.cmd' : 'dsh-hook.sh')

function readManagedHooks(): { hooks: Record<string, unknown[]> } {
  const parsed: { hooks: Record<string, unknown[]> } = JSON.parse(
    readFileSync(managedHooksPath(), 'utf-8')
  )
  return parsed
}

describe('DshHookService', () => {
  it('reports not_installed before install, with no DSH home on disk', () => {
    expect(new DshHookService().getStatus().state).toBe('not_installed')
  })

  it('installs the patch block, the managed hooks file, and the script', () => {
    const status = new DshHookService().install()
    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.configPath).toBe(configPath())

    const patch = readFileSync(configPath(), 'utf-8')
    expect(patch).toContain("name: '@deepseek-ai/dsh-hooks-claude-code'")
    expect(patch).toContain(`configPath: '${managedHooksPath()}'`)

    // Exactly the events DSH's bridge can fire — registering more would register nothing
    // for them and leave the status permanently `partial`.
    expect(Object.keys(readManagedHooks().hooks).sort()).toEqual([...DSH_HOOK_EVENTS].sort())
    expect(readFileSync(scriptPath(), 'utf-8').length).toBeGreaterThan(0)
  })

  it('posts to the dsh hook route', () => {
    new DshHookService().install()
    expect(readFileSync(scriptPath(), 'utf-8')).toContain('/hook/dsh')
  })

  it('restores the pane identity DSH scrubs before anything reads it', () => {
    // DSH drops env names containing KEY/TOKEN, so the script has to recover ORCA_PANE_KEY
    // and ORCA_AGENT_LAUNCH_TOKEN from their aliases before the guard or the spool run.
    new DshHookService().install()
    const script = readFileSync(scriptPath(), 'utf-8')
    const restoreAt = script.indexOf('ORCA_AGENT_PANE')
    const guardAt = script.indexOf('ORCA_AGENT_HOOK_PORT')
    expect(restoreAt).toBeGreaterThan(-1)
    expect(script).toContain('ORCA_AGENT_LAUNCH')
    expect(restoreAt).toBeLessThan(guardAt)
  })

  it('is idempotent', () => {
    const service = new DshHookService()
    service.install()
    const first = readFileSync(configPath(), 'utf-8')
    expect(service.install().state).toBe('installed')
    expect(readFileSync(configPath(), 'utf-8')).toBe(first)
  })

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

  // Why POSIX-only: on Windows chmod toggles the read-only attribute, so `mode & 0o777`
  // reads 0o666 for any writable file and the assertion cannot mean what it says.
  it.skipIf(process.platform === 'win32')('keeps an owner-only patch file owner-only', () => {
    // CWE-732: the temp+rename replacement must not widen the file to the umask default.
    const userRows = '- id: llm-deepseek\n  config: {}\n'
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(configPath(), userRows, 'utf-8')
    chmodSync(configPath(), 0o600)

    expect(new DshHookService().install().state).toBe('installed')
    expect(statSync(configPath()).mode & 0o777).toBe(0o600)
  })

  it('refuses a flow-style patch file instead of corrupting it', () => {
    // Appending a block entry after `[…]` is invalid YAML — DSH would then fail to load the
    // user's own layer as well as Orca's hooks, so install must change nothing.
    const flow = '[{ id: llm-deepseek }]\n'
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(configPath(), flow, 'utf-8')

    const service = new DshHookService()
    const installed = service.install()
    expect(installed.state).toBe('error')
    expect(installed.detail).toContain('flow-style sequence')
    expect(readFileSync(configPath(), 'utf-8')).toBe(flow)

    // Why re-read: a later status poll must keep saying why, not decay to a bare
    // `not_installed` that gives the user nothing to act on.
    const polled = service.getStatus()
    expect(polled.state).toBe('error')
    expect(polled.detail).toContain('flow-style sequence')
  })

  it('honours DSH_HOME', () => {
    const dshHome = join(home, 'custom-dsh-home')
    process.env.DSH_HOME = dshHome
    const status = new DshHookService().install()
    expect(status.configPath).toBe(join(dshHome, 'cordis.patch.yml'))
    expect(status.state).toBe('installed')
  })
})
