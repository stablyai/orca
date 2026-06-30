// Why: one regression fixture proves the managed hook timeout budget across every
// managed agent (config entries, wrapper curl flags, and a real dead-endpoint
// shell run) so the cross-agent coverage lives together rather than fragmenting.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type * as osModule from 'node:os'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock.mockImplementation(actual.homedir)
  }
})

import { MANAGED_HOOK_TIMEOUT_MILLISECONDS, MANAGED_HOOK_TIMEOUT_SECONDS } from './installer-utils'
import { CodexHookService } from '../codex/hook-service'
import { CursorHookService } from '../cursor/hook-service'
import { CommandCodeHookService } from '../command-code/hook-service'
import { GeminiHookService } from '../gemini/hook-service'
import { AntigravityHookService } from '../antigravity/hook-service'
import { ClaudeHookService } from '../claude/hook-service'
import { GrokHookService } from '../grok/hook-service'
import { CopilotHookService } from '../copilot/hook-service'
import { DevinHookService } from '../devin/hook-service'
import { DroidHookService } from '../droid/hook-service'
import { KimiHookService } from '../kimi/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
}

function createFakeSftp(initialFiles: Record<string, string> = {}): {
  sftp: SFTPWrapper
  fs: FakeFs
} {
  const fs: FakeFs = {
    files: new Map(Object.entries(initialFiles)),
    dirs: new Set(['/']),
    modes: new Map()
  }
  const noEntryError = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })

  const sftp = {
    readFile: (path: string, _enc: string, cb: (err: unknown, data?: string) => void): void => {
      const v = fs.files.get(path)
      if (v === undefined) {
        cb(noEntryError(path))
        return
      }
      cb(null, v)
    },
    writeFile: (
      path: string,
      content: string,
      options: string | { mode?: number },
      cb: (err: unknown) => void
    ): void => {
      fs.files.set(path, content)
      if (typeof options !== 'string' && options.mode !== undefined) {
        fs.modes.set(path, options.mode)
      }
      cb(null)
    },
    rename: (src: string, dst: string, cb: (err: unknown) => void): void => {
      const v = fs.files.get(src)
      if (v === undefined) {
        cb(noEntryError(src))
        return
      }
      fs.files.set(dst, v)
      fs.files.delete(src)
      const mode = fs.modes.get(src)
      if (mode !== undefined) {
        fs.modes.set(dst, mode)
        fs.modes.delete(src)
      }
      cb(null)
    },
    unlink: (path: string, cb: (err: unknown) => void): void => {
      fs.files.delete(path)
      fs.modes.delete(path)
      cb(null)
    },
    chmod: (path: string, mode: number, cb: (err: unknown) => void): void => {
      fs.modes.set(path, mode)
      cb(null)
    },
    stat: (path: string, cb: (err: unknown, stats?: { mode: number }) => void): void => {
      if (!fs.files.has(path)) {
        cb(noEntryError(path))
        return
      }
      cb(null, { mode: fs.modes.get(path) ?? 0o100644 })
    },
    readdir: (path: string, cb: (err: unknown, list?: { filename: string }[]) => void): void => {
      if (fs.dirs.has(path)) {
        cb(null, [])
        return
      }
      cb(noEntryError(path))
    },
    mkdir: (path: string, cb: (err: unknown) => void): void => {
      fs.dirs.add(path)
      cb(null)
    }
  } as unknown as SFTPWrapper
  return { sftp, fs }
}

const REMOTE_HOME = '/home/dev'

// Each managed agent that ships an SSH-compatible JSON/TOML hook config. Amp and
// Hermes are intentionally excluded: they are plugin systems with no hook config
// entries, so their transport budgets live in plugin source (see design doc).
const JSON_INSTALLERS = [
  {
    agent: 'claude',
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS,
    configPath: `${REMOTE_HOME}/.claude/settings.json`,
    install: (sftp: SFTPWrapper) => new ClaudeHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'openclaude',
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS,
    configPath: `${REMOTE_HOME}/.openclaude/settings.json`,
    install: (sftp: SFTPWrapper) => openClaudeHookService.installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'codex',
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS,
    configPath: `${REMOTE_HOME}/.codex/hooks.json`,
    install: (sftp: SFTPWrapper) => new CodexHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'gemini',
    timeout: MANAGED_HOOK_TIMEOUT_MILLISECONDS,
    configPath: `${REMOTE_HOME}/.gemini/settings.json`,
    install: (sftp: SFTPWrapper) => new GeminiHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'antigravity',
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS,
    configPath: `${REMOTE_HOME}/.gemini/config/hooks.json`,
    install: (sftp: SFTPWrapper) => new AntigravityHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'cursor',
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS,
    configPath: `${REMOTE_HOME}/.cursor/hooks.json`,
    install: (sftp: SFTPWrapper) => new CursorHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'command-code',
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS,
    configPath: `${REMOTE_HOME}/.commandcode/settings.json`,
    install: (sftp: SFTPWrapper) => new CommandCodeHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'grok',
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS,
    configPath: `${REMOTE_HOME}/.grok/hooks/orca-status.json`,
    install: (sftp: SFTPWrapper) => new GrokHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'copilot',
    timeout: 5,
    configPath: `${REMOTE_HOME}/.copilot/hooks/orca.json`,
    install: (sftp: SFTPWrapper) => new CopilotHookService().installRemote(sftp, REMOTE_HOME)
  },
  {
    agent: 'devin',
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS,
    configPath: `${REMOTE_HOME}/.config/devin/config.json`,
    install: (sftp: SFTPWrapper) => new DevinHookService().installRemote(sftp, REMOTE_HOME)
  }
] as const

const MANAGED_HOOKS_DIR_NEEDLE = '/.orca/agent-hooks/'

// Walk the parsed config and assert every Orca-managed command carrier (a node
// with a `command`/`bash`/`powershell` string pointing at the managed script
// dir) has a positive config-level timeout sibling (`timeout` or the
// provider-specific `timeoutSec`). Returns the count of managed carriers found
// so callers can assert the scan was not vacuous.
function countManagedCarriersWithTimeout(node: unknown, expectedTimeout: number): number {
  if (Array.isArray(node)) {
    return node.reduce<number>(
      (sum, child) => sum + countManagedCarriersWithTimeout(child, expectedTimeout),
      0
    )
  }
  if (node === null || typeof node !== 'object') {
    return 0
  }
  const record = node as Record<string, unknown>
  let found = 0
  const carrier = [record.command, record.bash, record.powershell].find(
    (value): value is string =>
      typeof value === 'string' && value.includes(MANAGED_HOOKS_DIR_NEEDLE)
  )
  if (carrier !== undefined) {
    const timeout = typeof record.timeout === 'number' ? record.timeout : record.timeoutSec
    expect(typeof timeout, `managed carrier "${carrier}" is missing a config timeout`).toBe(
      'number'
    )
    expect(timeout as number).toBe(expectedTimeout)
    found += 1
  }
  for (const value of Object.values(record)) {
    found += countManagedCarriersWithTimeout(value, expectedTimeout)
  }
  return found
}

describe('managed agent hook timeouts', () => {
  it('writes a config-level timeout on every managed JSON hook entry', async () => {
    for (const { agent, configPath, install, timeout } of JSON_INSTALLERS) {
      const { sftp, fs } = createFakeSftp()
      const status = await install(sftp)
      expect(status.state, `${agent} install state`).toBe('installed')
      const raw = fs.files.get(configPath)
      expect(raw, `${agent} config written`).toBeDefined()
      const carriers = countManagedCarriersWithTimeout(JSON.parse(raw!), timeout)
      expect(
        carriers,
        `${agent} should have at least one managed timeout-bearing entry`
      ).toBeGreaterThan(0)
    }
  })

  it('writes a timeout on the managed Kimi TOML hook block', async () => {
    const { sftp, fs } = createFakeSftp()
    const status = await new KimiHookService().installRemote(sftp, REMOTE_HOME)
    expect(status.state).toBe('installed')
    const config = fs.files.get(`${REMOTE_HOME}/.kimi-code/config.toml`)!
    // One timeout line per managed [[hooks]] event entry.
    const timeoutLines = config.match(new RegExp(`timeout = ${MANAGED_HOOK_TIMEOUT_SECONDS}`, 'g'))
    expect(timeoutLines?.length ?? 0).toBeGreaterThan(0)
    expect(config).toContain('/home/dev/.orca/agent-hooks/kimi-hook.sh')
  })

  it('writes a config-level timeout on local-only Droid hooks', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'orca-droid-hook-timeout-'))
    homedirMock.mockReturnValue(homeDir)
    try {
      const status = new DroidHookService().install()
      expect(status.state).toBe('installed')
      const config = JSON.parse(readFileSync(join(homeDir, '.factory', 'settings.json'), 'utf8'))
      const carriers = countManagedCarriersWithTimeout(config, MANAGED_HOOK_TIMEOUT_SECONDS)
      expect(carriers).toBeGreaterThan(0)
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('bounds every generated POSIX curl wrapper with --connect-timeout and --max-time', async () => {
    let curlWrappersChecked = 0
    for (const { agent, install } of JSON_INSTALLERS) {
      const { sftp, fs } = createFakeSftp()
      await install(sftp)
      for (const [path, content] of fs.files) {
        if (!path.endsWith('.sh')) {
          continue
        }
        expect(content, `${agent} wrapper missing curl transport`).toContain('curl')
        expect(content, `${agent} wrapper missing --connect-timeout`).toContain('--connect-timeout')
        expect(content, `${agent} wrapper missing --max-time`).toContain('--max-time')
        curlWrappersChecked += 1
      }
    }
    const kimi = createFakeSftp()
    await new KimiHookService().installRemote(kimi.sftp, REMOTE_HOME)
    const kimiWrapper = kimi.fs.files.get(`${REMOTE_HOME}/.orca/agent-hooks/kimi-hook.sh`)!
    expect(kimiWrapper, 'kimi wrapper missing --connect-timeout').toContain('--connect-timeout')
    expect(kimiWrapper, 'kimi wrapper missing --max-time').toContain('--max-time')
    curlWrappersChecked += 1
    expect(curlWrappersChecked).toBeGreaterThan(0)
  })

  describe('dead-endpoint transport budget', () => {
    let tempDir: string | null = null
    let server: Server | null = null
    const openSockets: Socket[] = []

    afterEach(() => {
      for (const socket of openSockets.splice(0)) {
        socket.destroy()
      }
      if (server) {
        server.close()
        server = null
      }
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
        tempDir = null
      }
    })

    const hasPosixCurl =
      process.platform !== 'win32' &&
      spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).status === 0

    function runHookScript(scriptPath: string, port: number): Promise<{ status: number | null }> {
      return new Promise((resolve, reject) => {
        const child = spawn('sh', [scriptPath], {
          env: {
            ...process.env,
            ORCA_AGENT_HOOK_ENDPOINT: '',
            ORCA_AGENT_HOOK_PORT: String(port),
            ORCA_AGENT_HOOK_TOKEN: 'test-token',
            ORCA_PANE_KEY: 'pane-1',
            ORCA_TAB_ID: 'tab-1',
            ORCA_WORKTREE_ID: 'wt-1'
          },
          stdio: ['pipe', 'ignore', 'ignore']
        })
        const timeout = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('hook script exceeded test timeout'))
        }, 10_000)
        child.on('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.on('close', (status) => {
          clearTimeout(timeout)
          resolve({ status })
        })
        child.stdin.end('{"hook_event_name":"Stop"}')
      })
    }

    // Why: an accepted-but-unanswered connection is the worst-case hang that only
    // `--max-time` (1.5s) governs — `--connect-timeout` already passes once the
    // TCP handshake completes. Point the wrapper at a real loopback listener that
    // accepts and then stalls, and assert the wrapper still returns well under a
    // generous CI budget.
    it.skipIf(!hasPosixCurl)(
      'returns within budget when the local listener accepts but never responds',
      async () => {
        // Reuse a real generated POSIX wrapper rather than re-deriving the script.
        const { sftp, fs } = createFakeSftp()
        await new CodexHookService().installRemote(sftp, REMOTE_HOME)
        const wrapperBody = fs.files.get(`${REMOTE_HOME}/.orca/agent-hooks/codex-hook.sh`)!

        tempDir = mkdtempSync(join(tmpdir(), 'orca-hook-timeout-'))
        const scriptPath = join(tempDir, 'codex-hook.sh')
        writeFileSync(scriptPath, wrapperBody, 'utf8')
        chmodSync(scriptPath, 0o755)

        const stallingServer = createServer((socket) => {
          // Accept the connection and hold it open without ever replying.
          openSockets.push(socket)
        })
        server = stallingServer
        const port = await new Promise<number>((resolve) => {
          stallingServer.listen(0, '127.0.0.1', () => {
            const address = stallingServer.address()
            resolve(typeof address === 'object' && address ? address.port : 0)
          })
        })

        const startedAt = Date.now()
        const result = await runHookScript(scriptPath, port)
        const elapsedMs = Date.now() - startedAt

        // The hook fails open (`|| true`) and exits 0 even though the POST timed out.
        expect(result.status).toBe(0)
        expect(openSockets.length).toBeGreaterThan(0)
        expect(elapsedMs).toBeGreaterThanOrEqual(1_000)
        // --max-time 1.5s + process overhead; a hang would blow well past this.
        expect(elapsedMs).toBeLessThan(6_000)
      }
    )
  })
})
