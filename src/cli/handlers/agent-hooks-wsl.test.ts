import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  statSync,
  existsSync,
  rmSync,
  realpathSync,
  promises as fs
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import type * as ProcessHost from '@orca/process-host'
import type * as WslRelayLaunch from '../../main/agent-hooks/wsl-hook-relay-launch'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildColocatedWslLauncher } from '../../main/cli/wsl-cli-scripts'
import { readWslCliContext } from '../../shared/wsl-cli-context'
import { runWslHookCommandSession } from '../../wsl-guest/wsl-hook-command-session'
import { main } from '../index'

const harness = vi.hoisted(() => ({
  spawn: vi.fn(),
  apply: vi.fn(),
  status: vi.fn(),
  call: vi.fn(),
  admission: vi.fn(),
  data: vi.fn()
}))
vi.mock('@orca/process-host', async (original) => ({
  ...(await original<typeof ProcessHost>()),
  spawnProcess: harness.spawn
}))
vi.mock('../../main/agent-hooks/wsl-hook-relay-launch', async (original) => ({
  ...(await original<typeof WslRelayLaunch>()),
  resolveWslHookRelayBundle: () => ({
    jsPath: 'C:\\owned\\relay\\wsl\\wsl-agent-hook-relay.js',
    version: '0.1.0+owned'
  })
}))
vi.mock('./account-wsl-location', () => ({
  // Portable transport boundary only; actual Windows/WSL interop remains a QA obligation.
  getWslAccountTarget: () => (process.env.ORCA_CLI_WSL_DISTRO ? { wslDistro: 'ProofDistro' } : null)
}))
vi.mock('../runtime-client', () => ({
  RuntimeClient: class {
    call = harness.call
    getOfflineRuntimeAdmission = harness.admission
  },
  RuntimeClientError: Error,
  getDefaultUserDataPath: harness.data
}))
vi.mock('../../main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: harness.apply,
  getManagedAgentHookStatuses: harness.status
}))

describe.skipIf(process.platform === 'win32')(
  'WSL hook command host boundary (portable real fs/session)',
  () => {
    let root: string
    let home: string
    let work: string
    let target: string
    let settings: string
    let sessions: Promise<void>[]
    let closes: number
    let inputs: PassThrough[]
    let releaseHeld = (): void => {}
    const policy: {
      agentStatusHooksEnabled: boolean
      disabledTuiAgents: string[]
      agentCmdOverrides: Record<string, string>
    } = { agentStatusHooksEnabled: true, disabledTuiAgents: [], agentCmdOverrides: {} }

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'pr31199-wsl-command-')))
      home = join(root, 'guest-home')
      work = join(root, "work ' λ")
      target = join(root, 'user-root')
      settings = join(target, 'settings.json')
      for (const dir of [home, work, target, join(root, 'interop')]) {
        mkdirSync(dir)
      }
      harness.data.mockReturnValue(join(root, 'windows-user-data'))
      harness.admission.mockResolvedValue({ reachable: true, legacyPidRunning: true })
      harness.call.mockImplementation(async () => ({ result: { settings: policy } }))
      harness.apply.mockImplementation(async (_enabled, _settings, options) => {
        expect(options.agents).not.toContain('claude')
        return []
      })
      mkdirSync(join(root, 'windows-user-data'))
      writeFileSync(
        join(root, 'windows-user-data', 'orca-data.json'),
        JSON.stringify({ settings: policy })
      )
      harness.status.mockImplementation(async (options) => {
        if (options?.agents) {
          expect(options.agents).not.toContain('claude')
        }
        return []
      })
      closes = 0
      sessions = []
      inputs = []
      releaseHeld = (): void => {}
      vi.stubEnv('HOME', home)
      vi.stubEnv('USERPROFILE', home)
      vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg-config'))
      vi.stubEnv('XDG_DATA_HOME', join(home, 'xdg-data'))
      vi.stubEnv('CLAUDE_CONFIG_DIR', '../injected')
      vi.stubEnv('ORCA_CLAUDE_INJECTED_CONFIG_DIR', '../injected')
      vi.stubEnv('ORCA_CLAUDE_USER_CONFIG_DIR', '../user-root')
      vi.stubEnv('ORCA_CLAUDE_PROFILE_POINTER', 'literal-profile')
      vi.stubEnv('ORCA_CLI_WSL_DISTRO', 'ProofDistro')
      vi.spyOn(process, 'cwd').mockReturnValue(work)
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      process.exitCode = undefined
      const cli = join(root, 'claude-fixture')
      writeFileSync(cli, '#!/bin/sh\nprintf "2.1.261 (Claude Code)\\n"\n', { mode: 0o700 })
      policy.agentCmdOverrides = { claude: cli }
      harness.spawn.mockImplementation((spec) => {
        expect(spec.args.slice(0, 5)).toEqual([
          '-d',
          'ProofDistro',
          '-u',
          userInfo().username,
          '--exec'
        ])
        expect(spec.args.at(-1)).toContain('unset NODE_OPTIONS NODE_REPL_EXTERNAL_MODULE')
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => {
            throw new Error('Command publication must be joined, not killed')
          }
        })
        inputs.push(child.stdin)
        const running = runWslHookCommandSession(child.stdin, child.stdout)
        sessions.push(running)
        void running.then(
          () => {
            closes++
            child.emit('close', 0)
          },
          (error) => child.emit('error', error)
        )
        return child
      })
    })

    afterEach(async () => {
      releaseHeld()
      for (const input of inputs) {
        input.end()
      }
      await Promise.allSettled(sessions)
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      vi.clearAllMocks()
      process.exitCode = undefined
      rmSync(root, { recursive: true, force: true })
    })

    function captureWrapperContext(): string {
      const bin = join(root, 'interop')
      const wrapper = join(bin, 'orca-ide')
      const powershell = join(bin, 'powershell.exe')
      writeFileSync(wrapper, buildColocatedWslLauncher('C:\\Orca\\orca.exe', powershell))
      writeFileSync(join(bin, 'wslpath'), '#!/bin/sh\nprintf "%s" "$2"\n', { mode: 0o700 })
      writeFileSync(powershell, '#!/bin/bash\nprintf "%s\\0" "$@"\n', { mode: 0o700 })
      const result = runProcessSync({
        program: '/bin/bash',
        args: [wrapper, 'agent', 'hooks', 'on'],
        cwd: work,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WSL_DISTRO_NAME: 'ProofDistro' }
      })
      expect(result.code, result.stderr).toBe(0)
      const argv = result.stdout.split('\0')
      expect(argv.slice(-4, -1)).toEqual(['agent', 'hooks', 'on'])
      const raw = argv[argv.indexOf('-WslContext') + 1]
      expect(readWslCliContext(raw)).toEqual({
        user: userInfo().username,
        home,
        cwd: work,
        env: {
          HOME: home,
          CLAUDE_CONFIG_DIR: '../injected',
          ORCA_CLAUDE_INJECTED_CONFIG_DIR: '../injected',
          ORCA_CLAUDE_USER_CONFIG_DIR: '../user-root',
          ORCA_CLAUDE_PROFILE_POINTER: 'literal-profile'
        }
      })
      vi.stubEnv('ORCA_CLI_WSL_CONTEXT', raw)
      return raw
    }

    async function command(action: string): Promise<Record<string, unknown>> {
      vi.mocked(console.log).mockClear()
      await main(['agent', 'hooks', action, '--json'], work)
      expect(process.exitCode, JSON.stringify(vi.mocked(console.log).mock.calls)).not.toBe(1)
      const text = vi.mocked(console.log).mock.calls.at(-1)?.[0]
      return JSON.parse(String(text)).result
    }

    it('carries original wrapper context through CLI, mux, guest authority and a linked event-only lifecycle', async () => {
      captureWrapperContext()
      const physical = join(root, 'physical.json')
      const user = {
        model: 'user-model',
        statusLine: { command: 'user-status' },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }]
        }
      }
      writeFileSync(physical, JSON.stringify(user), { mode: 0o640 })
      symlinkSync(physical, settings)
      expect((await command('status')).statuses).toEqual([
        expect.objectContaining({ state: 'not_installed', configPath: settings })
      ])
      expect(existsSync(join(home, '.orca'))).toBe(false)
      let installedBytes = ''
      for (const [index, action] of ['on', 'on', 'status'].entries()) {
        if (index === 1) {
          harness.admission.mockResolvedValue({ reachable: false, legacyPidRunning: false })
        }
        if (index === 2) {
          harness.admission.mockResolvedValue({ reachable: true, legacyPidRunning: true })
        }
        expect((await command(action)).statuses).toEqual([
          expect.objectContaining({ state: 'installed', configPath: settings })
        ])
        expect(lstatSync(settings).isSymbolicLink()).toBe(true)
        expect(statSync(physical).mode & 0o777).toBe(0o640)
        const actual = JSON.parse(readFileSync(physical, 'utf8'))
        expect(actual.model).toBe(user.model)
        expect(actual.statusLine).toEqual(user.statusLine)
        expect(actual.hooks.Stop[0]).toEqual(user.hooks.Stop[0])
        if (index === 0) {
          installedBytes = readFileSync(physical, 'utf8')
        } else {
          expect(readFileSync(physical, 'utf8')).toBe(installedBytes)
        }
      }
      harness.admission.mockResolvedValue({ reachable: false, legacyPidRunning: false })
      for (const action of ['off', 'off', 'status']) {
        expect((await command(action)).statuses).toEqual([
          expect.objectContaining({ state: 'not_installed', configPath: settings })
        ])
        expect(JSON.parse(readFileSync(physical, 'utf8'))).toEqual(user)
        expect(existsSync(join(home, '.claude'))).toBe(false)
      }
      expect(closes).toBe(7)
      expect(harness.apply).toHaveBeenCalledTimes(3)
      expect(harness.status).toHaveBeenCalledTimes(4)
      expect(harness.call).toHaveBeenCalledWith('settings.get')
    })

    it('keeps invalid settings intact and joins a cancellation held inside physical publication', async () => {
      captureWrapperContext()
      writeFileSync(settings, '{invalid')
      expect((await command('on')).statuses).toEqual([
        expect.objectContaining({ state: 'error', configPath: settings })
      ])
      expect(readFileSync(settings, 'utf8')).toBe('{invalid')
      expect(closes).toBe(1)
      // An actual admitted open is held; command EOF must wait, then fence rename and clean its temporary.
      const { openWslHookCommandSession } =
        await import('../../main/agent-hooks/wsl-hook-command-session')
      const { WSL_HOOK_FS_METHODS } = await import('../../shared/wsl-hook-relay-contract')
      const session = await openWslHookCommandSession(
        'ProofDistro',
        process.env.ORCA_CLI_WSL_CONTEXT ?? ''
      )
      let admitted!: () => void
      const entered = new Promise<void>((resolve) => {
        admitted = resolve
      })
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
        releaseHeld = resolve
      })
      const open = fs.open.bind(fs)
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const file = await open(...args)
        admitted()
        await held
        return file
      })
      const abort = new AbortController()
      const publishing = session.mux.request(
        WSL_HOOK_FS_METHODS.writeFile,
        {
          path: settings,
          content: '{}',
          physicalAtomic: true
        },
        { signal: abort.signal }
      )
      void publishing.catch(() => {})
      await entered
      abort.abort()
      await expect(publishing).rejects.toMatchObject({ name: 'AbortError' })
      let settled = false
      const closing = session.close().then(() => {
        settled = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      release()
      await closing
      await publishing.catch(() => {})
      expect(readFileSync(settings, 'utf8')).toBe('{invalid')
      expect(await fs.readdir(target)).toEqual(['settings.json'])
      expect(closes).toBe(2)
    })
  }
)
