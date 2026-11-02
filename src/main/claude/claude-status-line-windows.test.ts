// Why: Claude runs the statusLine under Git Bash when present, else PowerShell. The POSIX
// runtime-home form Orca used to register is a PowerShell parse error, so a Windows box
// without Git Bash never posted rate_limits and the live usage feed went dark.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { parseClaudeStatusLineBody } from '../../shared/claude-statusline-rate-limits'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock.mockImplementation(actual.homedir) }
})

import { findGitBash } from '../agent-hooks/windows-git-bash-path.test-fixture'
import { ClaudeHookService } from './hook-service'
import { getManagedCommand } from './hook-settings'

const CURRENT_CLAUDE = { claudeVersion: '2.1.261 (Claude Code)' }
const PAYLOAD = JSON.stringify({
  session_id: 'statusline-delivery',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: 1790000000 },
    seven_day: { used_percentage: 7, resets_at: 1790500000 }
  }
})
const EXPECTED_RATE_LIMITS = {
  configDir: null,
  fiveHour: { used_percentage: 42, resets_at: 1790000000 },
  sevenDay: { used_percentage: 7, resets_at: 1790500000 }
}
const HOOK_TOKEN = 'statusline-delivery-token'
// Why: claude.exe's own PowerShell argv (-ExecutionPolicy Bypass unless told to respect it).
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

// The pre-fix registration; it resolves HOME at run time, so it names no profile path.
const LEGACY_COMMAND = getManagedCommand('claude-statusline.cmd')

type StatusLineSettings = { statusLine?: { type: string; command: string } }

function settingsPath(home: string): string {
  return join(home, '.claude', 'settings.json')
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

async function startStatusLineListener(): Promise<{
  server: Server
  port: number
  posts: Record<string, string>[]
}> {
  const posts: Record<string, string>[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      posts.push({ ...Object.fromEntries(new URLSearchParams(body)), path: req.url ?? '' })
      res.writeHead(200)
      res.end()
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  return { server, port, posts }
}

describe.skipIf(process.platform !== 'win32')('Claude statusLine delivery on Windows', () => {
  let home = ''
  let server: Server | null = null

  afterEach(() => {
    server?.close()
    server = null
    homedirMock.mockReset()
    if (home) {
      removeTreeSync(home)
      home = ''
    }
  })

  async function installInto(prefix: string, seed?: StatusLineSettings) {
    home = mkdtempSync(join(tmpdir(), prefix))
    homedirMock.mockReturnValue(home)
    // Why: a developer's cmd AutoRun commonly targets %USERPROFILE%\.cmd_aliases.cmd.
    writeFileSync(join(home, '.cmd_aliases.cmd'), '@rem\r\n', 'utf8')
    if (seed) {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(settingsPath(home), JSON.stringify(seed))
    }
    new ClaudeHookService().install(CURRENT_CLAUDE)
    const settings: StatusLineSettings = JSON.parse(readFileSync(settingsPath(home), 'utf-8'))
    const command = settings.statusLine?.command
    if (!command) {
      throw new Error('Missing managed statusLine command')
    }

    const listener = await startStatusLineListener()
    server = listener.server
    const baseEnv = Object.fromEntries(
      // Why: never reach a live Orca, and a hosting Claude's CLAUDE_JOB_DIR would gate the script off.
      Object.entries(process.env).filter(([key]) => !/^(ORCA|CLAUDE)_/.test(key))
    )
    const run = (program: string, args: string[], paneId: number) =>
      runProcess({
        program,
        args,
        input: PAYLOAD,
        timeoutMs: 15_000,
        env: {
          ...baseEnv,
          USERPROFILE: home,
          HOME: home,
          // Why: keeps the per-pane throttle stamp out of the real %TEMP%.
          TEMP: home,
          TMP: home,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_AGENT_HOOK_PORT: String(listener.port),
          ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
          ORCA_PANE_KEY: `tab-1:00000000-0000-4000-8000-00000000000${paneId}`
        }
      })
    return { command, posts: listener.posts, run }
  }

  it('upgrades the runtime-home entry to one Windows PowerShell 5.1 and Git Bash both post through', async () => {
    const { command, posts, run } = await installInto('orca-claude-statusline-run-', {
      statusLine: { type: 'command', command: LEGACY_COMMAND }
    })
    expect(command).toBe(
      join(home, '.orca', 'agent-hooks', 'claude-statusline.cmd').replaceAll('\\', '/')
    )

    // Pinned so this suite proves the regression it guards.
    const legacy = await run(powershellPath(), [...POWERSHELL_ARGS, LEGACY_COMMAND], 0)
    expect(legacy.code).not.toBe(0)
    expect(posts).toHaveLength(0)

    const shells = [
      {
        name: 'Windows PowerShell',
        program: powershellPath(),
        args: [...POWERSHELL_ARGS, command]
      },
      { name: 'Git Bash', program: findGitBash(), args: ['-c', command] }
    ]
    for (const [index, shell] of shells.entries()) {
      const result = await run(shell.program, shell.args, index + 1)
      expect(result.timedOut, `${shell.name} timed out`).toBe(false)
      expect(result.code, `${shell.name} exit code`).toBe(0)
      // Why: parity with the POSIX script — the usage feed must not change what Claude displays.
      expect(result.stdout, `${shell.name} stdout`).toBe('')
      expect(result.stderr, `${shell.name} stderr`).toBe('')
      expect(posts[index]?.path, `${shell.name} posted`).toBe('/statusline/claude')
      expect(parseClaudeStatusLineBody(posts[index])).toEqual(EXPECTED_RATE_LIMITS)
    }
    expect(posts).toHaveLength(shells.length)
  }, 60_000)

  it('starts no PowerShell per tick for a profile path with a space', async () => {
    const { command, posts, run } = await installInto('orca claude statusline space ')
    expect(command).toBe(LEGACY_COMMAND)

    // Why: the xtrace shows every command Git Bash ran, so an encoded launcher would surface here.
    const result = await run(findGitBash(), ['-xc', command], 1)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toMatch(/powershell|-EncodedCommand/i)
    expect(posts).toHaveLength(1)
    expect(parseClaudeStatusLineBody(posts[0])).toEqual(EXPECTED_RATE_LIMITS)

    // Accepted trade-off: PowerShell-only hosts on such a path stay on the OAuth usage poll.
    await run(powershellPath(), [...POWERSHELL_ARGS, command], 2)
    expect(posts).toHaveLength(1)
  }, 60_000)
})
