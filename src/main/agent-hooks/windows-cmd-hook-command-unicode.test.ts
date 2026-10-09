import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'
import { runProcess } from '../../shared/child-process/run-process'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import {
  isPlainObject,
  readHooksJson,
  WINDOWS_CMD_SAFE_PATH,
  wrapWindowsCmdHookCommand,
  wrapWindowsHookCommand,
  writeHooksJson
} from './installer-utils'
import { wrapWindowsDirectCmdHookCommand } from './windows-direct-cmd-hook-command'
import { AntigravityHookService } from '../antigravity/hook-service'
import { ANTIGRAVITY_EVENTS } from '../antigravity/hook-events'
import { getWindowsPowerShellExecutablePath } from './windows-powershell-hook-launcher'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock.mockImplementation(actual.homedir) }
})
afterEach(() => vi.restoreAllMocks())

const PROFILES = ['ascii', '홍길동', '测试用户', '日本語', 'rené', 'rene\u0301']

function decodeCommand(command: string): string {
  const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  if (!encoded) {
    throw new Error('Missing encoded command')
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('Windows Unicode managed hook commands', () => {
  it('keeps the existing ASCII direct path', () => {
    const scriptPath = 'C:\\Users\\ascii\\.orca\\agent-hooks\\antigravity-pre-tool-use.cmd'
    expect(wrapWindowsCmdHookCommand(scriptPath)).toBe(scriptPath)
    expect(wrapWindowsDirectCmdHookCommand(scriptPath)).toBe(scriptPath.replaceAll('\\', '/'))
  })

  it.each(PROFILES.slice(1))(
    'preserves the guarded launcher for %s without policy setup',
    (profile) => {
      const scriptPath = `C:\\Users\\${profile}\\.orca\\agent-hooks\\antigravity-pre-tool-use.cmd`
      const decoded = decodeCommand(wrapWindowsCmdHookCommand(scriptPath))
      expect(decoded).toContain(`Test-Path -LiteralPath '${scriptPath}' -PathType Leaf`)
      expect(decoded).toContain('[Console]::In.ReadToEnd() | Out-Null; exit 0')
      expect(decoded).not.toContain('Set-ExecutionPolicy')
      expect(decoded).toContain("$env:PSExecutionPolicyPreference='Bypass'")
      expect(wrapWindowsDirectCmdHookCommand(scriptPath)).toBeNull()
    }
  )

  it.each([
    '测试 用户',
    '用户%PATH%',
    '用户!PATH!',
    '用户&exit',
    '用户^name',
    "用户'name",
    '用户;exit',
    '用户\u3000name',
    '用户$name',
    '用户(name)',
    '用户`name',
    '用户\u2019name'
  ])('retains the encoded launcher for %s', (profile) => {
    const scriptPath = `C:\\Users\\${profile}\\.orca\\agent-hooks\\antigravity-pre-tool-use.cmd`
    expect(wrapWindowsCmdHookCommand(scriptPath)).toBe(wrapWindowsHookCommand(scriptPath))
    expect(wrapWindowsDirectCmdHookCommand(scriptPath)).toBeNull()
  })
})

function installedCommand(configPath: string, eventName: string): string {
  const config = readHooksJson(configPath)
  const bundle = config?.['orca-status']
  if (!isPlainObject(bundle) || !Array.isArray(bundle[eventName])) {
    throw new Error(`Missing ${eventName} hook`)
  }
  const definition = bundle[eventName][0]
  if (!isPlainObject(definition)) {
    throw new Error('Invalid hook definition')
  }
  const nested = Array.isArray(definition.hooks) ? definition.hooks[0] : null
  const command = definition.command ?? (isPlainObject(nested) ? nested.command : null)
  if (typeof command !== 'string') {
    throw new Error('Missing hook command')
  }
  return command
}

describe.skipIf(
  process.platform !== 'win32' || !WINDOWS_CMD_SAFE_PATH.test(join(tmpdir(), 'hook.cmd'))
)('Registered Unicode Antigravity hooks', () => {
  it.each(PROFILES)(
    'delivers all events from %s after upgrading encoded commands',
    async (profile) => {
      const home = mkdtempSync(join(tmpdir(), `orca-hook-${profile}-`))
      homedirMock.mockReturnValue(home)
      const service = new AntigravityHookService()
      service.setWindowsRuntimePathProvider(() => process.execPath)
      const configPath = join(home, '.gemini', 'config', 'hooks.json')
      const legacyCommand = wrapWindowsHookCommand(
        join(home, '.orca', 'agent-hooks', 'antigravity-pre-tool-use.cmd')
      )
      writeHooksJson(configPath, {
        'orca-status': {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: legacyCommand }] }]
        }
      })
      const posts: URLSearchParams[] = []
      const server = createServer((req, res) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          posts.push(new URLSearchParams(body))
          res.writeHead(204).end()
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        expect(service.install().state).toBe('installed')
        expect(service.getStatus().state).toBe('installed')
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('Missing listener port')
        }
        const payload = JSON.stringify({
          prompt: 'café 한국어 日本語 😀 & %PATH% !',
          text: 'y'.repeat(4096)
        })
        const env = {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
          ),
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_AGENT_HOOK_PORT: String(address.port),
          ORCA_AGENT_HOOK_TOKEN: 'unicode-command-test',
          ORCA_PANE_KEY: 'tab:leaf!bang',
          ORCA_WORKTREE_ID: 'folder::C:/测试 repo',
          ORCA_AGENT_HOOK_NODE: process.execPath
        }
        for (const event of ANTIGRAVITY_EVENTS) {
          const command = installedCommand(configPath, event.eventName)
          const scriptPath = join(home, '.orca', 'agent-hooks', event.windowsWrapperFileName)
          expect(command).toBe(wrapWindowsCmdHookCommand(scriptPath))
          if (!WINDOWS_CMD_SAFE_PATH.test(scriptPath)) {
            expect(decodeCommand(command)).not.toContain('Set-ExecutionPolicy')
          }
          const hosts = [
            {
              program: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
              args: ['/d', '/v:off', '/c', command]
            },
            {
              program: getWindowsPowerShellExecutablePath(),
              args: ['-NoProfile', '-Command', command]
            }
          ]
          for (const host of hosts) {
            const before = posts.length
            const result = await runProcess({
              ...host,
              env,
              input: payload,
              timeoutMs: 10_000,
              terminationBarrier: true
            })
            expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false })
            expect(result.stdout.trim()).toBe(
              event.eventName === 'PreToolUse'
                ? '{"decision":"ask"}'
                : event.eventName === 'Stop'
                  ? '{"decision":""}'
                  : '{}'
            )
            expect(posts.slice(before)).toHaveLength(1)
            expect(posts[before].get('payload')).toBe(payload)
            expect(posts[before].get('hook_event_name')).toBe(event.eventName)
            expect(posts[before].get('paneKey')).toBe(env.ORCA_PANE_KEY)
            expect(posts[before].get('worktreeId')).toBe(env.ORCA_WORKTREE_ID)
          }
        }
        const staleCommand = installedCommand(configPath, 'PreToolUse')
        const scriptPath = join(home, '.orca', 'agent-hooks', 'antigravity-pre-tool-use.cmd')
        rmSync(scriptPath)
        const beforeMissing = posts.length
        const invoke = () =>
          runProcess({
            program: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
            args: ['/d', '/v:off', '/c', staleCommand],
            env,
            input: payload,
            timeoutMs: 10_000,
            terminationBarrier: true
          })
        const missing = await invoke()
        expect(missing.timedOut).toBe(false)
        expect(missing.code).toBe(profile === 'ascii' ? 1 : 0)
        expect(missing.stdout).toBe('')
        if (profile === 'ascii') {
          expect(missing.stderr).not.toBe('')
        } else {
          expect(missing.stderr).toBe('')
        }
        expect(posts).toHaveLength(beforeMissing)
        // Status reflects registered commands; install restores a deleted wrapper.
        expect(service.getStatus().state).toBe('installed')
        expect(service.install().state).toBe('installed')
        expect(await invoke()).toMatchObject({
          code: 0,
          stdout: '{"decision":"ask"}\r\n',
          stderr: ''
        })
        expect(posts).toHaveLength(beforeMissing + 1)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await removeTree(home)
        homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      }
    },
    60_000
  )
})
