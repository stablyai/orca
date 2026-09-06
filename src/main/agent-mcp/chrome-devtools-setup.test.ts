import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { configureChromeDevtools } from './chrome-devtools-setup'
import { chromeDevtoolsCommand } from './chrome-devtools-config'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
vi.mock('./chrome-devtools-pi', () => ({
  planPiConfig: (home: string) => ({
    agent: 'pi',
    configPath: join(home, '.pi', 'agent', 'mcp.json'),
    before: null,
    after: '{}\n'
  })
}))
const roots: string[] = []
const stagedHomes: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'orca-mcp-test-'))
  roots.push(home)
  const codex = join(home, '.codex', 'config.toml')
  mkdirSync(dirname(codex), { recursive: true })
  return { home, codex }
}
beforeEach(() => {
  vi.mocked(runProcess).mockReset()
  vi.mocked(runProcess).mockImplementation(async (spec) => {
    const stagingHome = spec.env!.CODEX_HOME!
    stagedHomes.push(stagingHome)
    const config = readFileSync(join(stagingHome, 'config.toml'), 'utf8')
    const command = chromeDevtoolsCommand('linux')
    const servers = config.includes('[mcp_servers.chrome-devtools]')
      ? [
          {
            name: 'chrome-devtools',
            enabled: true,
            transport: {
              type: 'stdio',
              command: command[0],
              args: command.slice(1),
              env: null,
              cwd: null
            }
          }
        ]
      : []
    return { code: 0, signal: null, timedOut: false, stdout: JSON.stringify(servers), stderr: '' }
  })
})
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  for (const stage of stagedHomes.splice(0)) {
    expect(existsSync(stage)).toBe(false)
  }
})

describe('Chrome DevTools setup', () => {
  it('uses canonical Codex home, preserves user config and backup, and is idempotent', async () => {
    const { home, codex } = fixture()
    const original = '# user settings\r\nmodel = "custom"\r\n'
    writeFileSync(codex, original)
    const env = { CODEX_HOME: join(home, 'managed'), ORCA_CODEX_HOME: join(home, 'managed') }
    const result = await configureChromeDevtools({
      agent: 'codex',
      apply: true,
      home,
      env,
      platform: 'linux'
    })
    expect(readFileSync(codex, 'utf8')).toMatch(/^# user settings\r\nmodel = "custom"\r\n/)
    expect(readFileSync(codex, 'utf8')).toContain('startup_timeout_sec = 60')
    expect(readFileSync(result.configs[0].backupPath!, 'utf8')).toBe(original)
    expect(existsSync(env.CODEX_HOME)).toBe(false)
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['mcp', 'list', '--json'], timeoutMs: 15000 })
    )
    const again = await configureChromeDevtools({
      agent: 'codex',
      apply: true,
      home,
      env,
      platform: 'linux'
    })
    expect(again.configs[0].backupPath).toBeNull()
    expect(readdirSync(dirname(codex)).filter((name) => name.endsWith('.bak'))).toHaveLength(1)
  })
  it('dry-run plans both clients without creating canonical configs or backups', async () => {
    const { home, codex } = fixture()
    const result = await configureChromeDevtools({
      agent: 'all',
      apply: false,
      home,
      env: {},
      platform: 'linux'
    })
    expect(result.configs.map((config) => config.state)).toEqual([
      'missing',
      'missing',
      'missing',
      'missing'
    ])
    expect(result).toMatchObject({ mcpHandshake: 'not-checked', browserConnection: 'not-checked' })
    expect(existsSync(codex)).toBe(false)
    expect(existsSync(join(home, '.config'))).toBe(false)
  })
  it('preflights both clients before publishing either config', async () => {
    const { home, codex } = fixture()
    const openCode = join(home, '.config', 'opencode', 'opencode.json')
    mkdirSync(dirname(openCode), { recursive: true })
    writeFileSync(openCode, '{broken')
    await expect(
      configureChromeDevtools({ agent: 'all', apply: true, home, env: {}, platform: 'linux' })
    ).rejects.toThrow('Invalid')
    expect(existsSync(codex)).toBe(false)
  })
  it.each([
    { code: 1, timedOut: false },
    { code: null, timedOut: true }
  ])('fails closed on Codex validation failure %j', async (failure) => {
    const { home, codex } = fixture()
    writeFileSync(codex, '# preserve\n')
    vi.mocked(runProcess).mockResolvedValue({
      ...failure,
      signal: null,
      stdout: '',
      stderr: 'bad config'
    })
    await expect(
      configureChromeDevtools({ agent: 'codex', apply: true, home, env: {}, platform: 'linux' })
    ).rejects.toThrow('could not validate')
    expect(readFileSync(codex, 'utf8')).toBe('# preserve\n')
    expect(readdirSync(dirname(codex))).toEqual(['config.toml'])
  })
  it('does not treat a disabled existing server as configured', async () => {
    const { home } = fixture()
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      timedOut: false,
      stderr: '',
      stdout: JSON.stringify([{ name: 'chrome-devtools', enabled: false }])
    })
    await expect(
      configureChromeDevtools({ agent: 'codex', apply: false, home, env: {}, platform: 'linux' })
    ).rejects.toThrow('Conflicting')
  })
  it('refuses to overwrite a concurrent edit made during validation', async () => {
    const { home, codex } = fixture()
    const originalImplementation = vi.mocked(runProcess).getMockImplementation()!
    vi.mocked(runProcess).mockImplementation(async (spec) => {
      const result = await originalImplementation(spec)
      writeFileSync(codex, '# concurrent user edit\n')
      return result
    })
    await expect(
      configureChromeDevtools({ agent: 'codex', apply: true, home, env: {}, platform: 'linux' })
    ).rejects.toThrow('changed during validation')
    expect(readFileSync(codex, 'utf8')).toBe('# concurrent user edit\n')
  })
})
