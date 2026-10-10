import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createManagedHookLocalFilesystem } from '../agent-hooks/managed-hook-local-filesystem'
import { isPlainObject } from '../agent-hooks/installer-utils'
import { KiroHookService } from './hook-service'
import { getKiroManagedCommandMatcher, KIRO_HOOK_EVENTS } from './hook-settings'

// Why both names: os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows; setting
// only one would let a run edit the developer's real ~/.kiro or ~/.orca.
let home: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalKiroHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-kiro-hook-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  originalKiroHome = process.env.KIRO_HOME
  delete process.env.KIRO_HOME
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
  if (originalKiroHome === undefined) {
    delete process.env.KIRO_HOME
  } else {
    process.env.KIRO_HOME = originalKiroHome
  }
  rmSync(home, { recursive: true, force: true })
})

const agentsDir = (): string => join(home, '.kiro', 'agents')
const agentPath = (name: string): string => join(agentsDir(), `${name}.json`)
const scriptPath = (): string =>
  join(
    home,
    '.orca',
    'agent-hooks',
    process.platform === 'win32' ? 'kiro-hook.cmd' : 'kiro-hook.sh'
  )

function writeAgent(name: string, config: unknown): void {
  mkdirSync(agentsDir(), { recursive: true })
  writeFileSync(agentPath(name), `${JSON.stringify(config, null, 2)}\n`)
}

function readAgent(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(agentPath(name), 'utf-8'))
}

const USER_STOP_HOOK = { command: 'say done' }

describe('KiroHookService', () => {
  it('reports the built-in default agent gap when no custom agents exist', () => {
    const result = new KiroHookService().install()
    expect(result.state).toBe('not_installed')
    expect(result.detail).toContain('kiro-cli agent create')
    expect(result.detail).toContain(agentsDir())
    // The launcher is still laid down so the refresher can keep it current.
    expect(existsSync(scriptPath())).toBe(true)
  })

  it('adds one managed hook per event to every agent and keeps user hooks', () => {
    writeAgent('caverna', { name: 'caverna', tools: ['*'], hooks: { stop: [USER_STOP_HOOK] } })
    writeAgent('reviewer', { name: 'reviewer', tools: ['read'] })

    const service = new KiroHookService()
    expect(service.install().state).toBe('installed')
    // Idempotent: a second install must not duplicate the managed entries.
    expect(service.install().state).toBe('installed')

    const caverna = readAgent('caverna')
    expect(caverna.tools).toEqual(['*'])
    const hooks = caverna.hooks
    if (!isPlainObject(hooks)) {
      throw new Error('Expected hooks object')
    }
    expect(Object.keys(hooks).sort()).toEqual([...KIRO_HOOK_EVENTS].sort())
    const isManaged = getKiroManagedCommandMatcher()
    for (const event of KIRO_HOOK_EVENTS) {
      const entries = hooks[event]
      if (!Array.isArray(entries)) {
        throw new Error('Expected hook array')
      }
      expect(
        entries.filter((entry) => isPlainObject(entry) && isManaged(String(entry.command)))
      ).toHaveLength(1)
    }
    expect(hooks.stop).toEqual([
      USER_STOP_HOOK,
      expect.objectContaining({ command: expect.any(String) })
    ])
    expect(hooks.preToolUse).toEqual([expect.objectContaining({ matcher: '*' })])
    expect(readAgent('reviewer').hooks).toBeDefined()
  })

  it('reports partial when an agent file cannot be parsed and leaves it untouched', () => {
    writeAgent('good', { name: 'good' })
    mkdirSync(agentsDir(), { recursive: true })
    writeFileSync(agentPath('broken'), '{ not json')

    const result = new KiroHookService().install()
    expect(result.state).toBe('partial')
    expect(result.detail).toContain('broken.json is not valid JSON')
    expect(readFileSync(agentPath('broken'), 'utf-8')).toBe('{ not json')
  })

  it('reports partial when an agent created after install has no hooks yet', () => {
    writeAgent('first', { name: 'first' })
    const service = new KiroHookService()
    service.install()
    writeAgent('later', { name: 'later' })

    const result = service.getStatus()
    expect(result.state).toBe('partial')
    expect(result.detail).toContain('later.json has no Orca hooks')
  })

  it('reports a missing launcher as partial instead of installed', () => {
    writeAgent('tracked', { name: 'tracked' })
    const service = new KiroHookService()
    service.install()
    rmSync(scriptPath())
    expect(service.getStatus()).toMatchObject({
      state: 'partial',
      managedHooksPresent: true,
      detail: expect.stringContaining('script missing')
    })
  })

  it.each([{ hooks: [] }, { hooks: 'keep this' }, { hooks: { stop: { command: 'say done' } } }])(
    'preserves unsupported user hook structures and reports them locally and remotely: %j',
    async ({ hooks }) => {
      writeAgent('unsupported', { name: 'unsupported', hooks })
      const original = readFileSync(agentPath('unsupported'), 'utf-8')
      const service = new KiroHookService()
      expect(service.install()).toMatchObject({ state: 'error' })
      expect(readFileSync(agentPath('unsupported'), 'utf-8')).toBe(original)
      expect(await service.installRemote(createManagedHookLocalFilesystem(), home)).toMatchObject({
        state: 'error'
      })
      expect(readFileSync(agentPath('unsupported'), 'utf-8')).toBe(original)
    }
  )

  it('removes only managed hooks and drops the hooks block it emptied', () => {
    writeAgent('caverna', { name: 'caverna', hooks: { stop: [USER_STOP_HOOK] } })
    writeAgent('plain', { name: 'plain' })
    const service = new KiroHookService()
    service.install()

    expect(service.remove().state).toBe('not_installed')
    expect(readAgent('caverna').hooks).toEqual({ stop: [USER_STOP_HOOK] })
    expect(readAgent('plain')).toEqual({ name: 'plain' })
  })

  it('patches the agents under $KIRO_HOME instead of ~/.kiro', () => {
    const kiroHome = join(home, 'custom-kiro')
    mkdirSync(join(kiroHome, 'agents'), { recursive: true })
    writeFileSync(join(kiroHome, 'agents', 'relocated.json'), JSON.stringify({ name: 'relocated' }))
    process.env.KIRO_HOME = kiroHome
    expect(new KiroHookService().install().state).toBe('installed')
    expect(existsSync(agentsDir())).toBe(false)
  })

  it('patches the remote agents under the probed KIRO_HOME, not ~/.kiro', async () => {
    const kiroHome = join(home, 'remote-kiro')
    mkdirSync(join(kiroHome, 'agents'), { recursive: true })
    writeFileSync(join(kiroHome, 'agents', 'remote.json'), JSON.stringify({ name: 'remote' }))
    writeAgent('stale', { name: 'stale' })

    const result = await new KiroHookService().installRemote(
      createManagedHookLocalFilesystem(),
      home,
      kiroHome
    )

    expect(result.state).toBe('installed')
    const remote = JSON.parse(readFileSync(join(kiroHome, 'agents', 'remote.json'), 'utf-8'))
    expect(Object.keys(remote.hooks).sort()).toEqual([...KIRO_HOOK_EVENTS].sort())
    // The inactive default home is left alone.
    expect(readAgent('stale').hooks).toBeUndefined()
  })

  it('falls back to <remoteHome>/.kiro/agents when no KIRO_HOME was probed', async () => {
    writeAgent('default', { name: 'default' })

    const result = await new KiroHookService().installRemote(
      createManagedHookLocalFilesystem(),
      home
    )

    expect(result.state).toBe('installed')
    expect(readAgent('default').hooks).toBeDefined()
  })

  it('reports a remote agent deleted after the listing as unreadable, not invalid JSON', async () => {
    writeAgent('kept', { name: 'kept' })
    writeAgent('gone', { name: 'gone' })
    const sftp = createManagedHookLocalFilesystem()
    const readFile = sftp.readFile
    Object.assign(sftp, {
      readFile: (
        path: string,
        encoding: BufferEncoding,
        callback: (error: Error | undefined, contents: Buffer) => void
      ) => {
        if (path.endsWith('gone.json')) {
          rmSync(path)
        }
        return readFile(path, encoding, callback)
      }
    })

    const result = await new KiroHookService().installRemote(sftp, home)

    expect(result.state).toBe('partial')
    expect(result.detail).toContain('gone.json is could not be read')
    expect(result.detail).not.toContain('not valid JSON')
    expect(readAgent('kept').hooks).toBeDefined()
  })

  it('ignores non-JSON files such as the shipped example config', () => {
    mkdirSync(agentsDir(), { recursive: true })
    writeFileSync(join(agentsDir(), 'agent_config.json.example'), '{}')
    expect(new KiroHookService().install().state).toBe('not_installed')
    expect(readFileSync(join(agentsDir(), 'agent_config.json.example'), 'utf-8')).toBe('{}')
  })
})
