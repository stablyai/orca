// Why (#15833): Codex 0.149 never closes a hook's stdin and does not enforce the
// config-declared timeout for a shell-wrapped command holding stdin, so the managed
// codex bridge's read-to-EOF blocked forever and every UserPromptSubmit wedged the
// TUI. This fixture proves the generated script bounds its own stdin wait and that
// the wrapper execs the script so an external timeout kill reaches the real process.
import { describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

import { buildPosixHookPayloadCapture } from '../agent-hooks/hook-stdin-contract'
import { CodexHookService } from './hook-service'
import { createAgentHookMemorySftp as createFakeSftp } from '../agent-hooks/agent-hook-memory-sftp.test-fixture'

const REMOTE_HOME = '/home/dev'
const SCRIPT_PATH = `${REMOTE_HOME}/.orca/agent-hooks/codex-hook.sh`

async function generateCodexHookScript(): Promise<string> {
  const { sftp, fs } = createFakeSftp()
  const status = await new CodexHookService().installRemote(sftp, REMOTE_HOME)
  expect(status.state).toBe('installed')
  const script = fs.files.get(SCRIPT_PATH)
  expect(script).toBeDefined()
  return script!
}

const hasPosixShell =
  spawnSync('sh', ['-c', 'command -v cat && command -v sleep && command -v kill'], {
    encoding: 'utf8'
  }).status === 0

function runScriptWithStdin(
  scriptBody: string,
  stdinBehavior: 'never-close' | 'close-empty'
): Promise<{ status: number | null; signal: NodeJS.Signals | null; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-codex-stdin-'))
    const scriptPath = join(tempDir, 'codex-hook.sh')
    writeFileSync(scriptPath, scriptBody, 'utf8')
    chmodSync(scriptPath, 0o755)

    const child = spawn('sh', [scriptPath], {
      env: {
        ...process.env,
        ORCA_AGENT_HOOK_ENDPOINT: '',
        ORCA_AGENT_HOOK_PORT: '1',
        ORCA_AGENT_HOOK_TOKEN: 'test-token',
        ORCA_PANE_KEY: 'pane-1',
        ORCA_TAB_ID: 'tab-1',
        ORCA_WORKTREE_ID: 'wt-1'
      },
      stdio: ['pipe', 'ignore', 'ignore']
    })
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL')
      rmSync(tempDir, { recursive: true, force: true })
      reject(new Error('script still running at the test kill budget'))
    }, 20_000)
    const startedAt = Date.now()
    child.on('error', (error) => {
      clearTimeout(killTimer)
      rmSync(tempDir, { recursive: true, force: true })
      reject(error)
    })
    child.on('close', (status, signal) => {
      clearTimeout(killTimer)
      rmSync(tempDir, { recursive: true, force: true })
      resolve({ status, signal, elapsedMs: Date.now() - startedAt })
    })

    // The #15833 wedge: Codex submits the hook and never closes stdin.
    if (stdinBehavior === 'close-empty') {
      child.stdin.end('')
    }
  })
}

describe('managed codex POSIX hook stdin bound (#15833)', () => {
  it('bounds the payload capture with a watchdog under the declared hook timeout', async () => {
    const script = await generateCodexHookScript()

    // The watchdog: a backgrounded sleep that kills the whole script after the budget, so a
    // runner that never closes stdin costs the hook its own life instead of wedging the turn.
    expect(script).toContain('orca_hook_stdin_watchdog=$!')
    expect(script).toMatch(/\( sleep \d+; kill -9 "\$\$" 2>\/dev\/null \)/)
    // The wrapper in hooks.json must exec the script so a runner timeout kill reaches it.
    const { sftp, fs } = createFakeSftp()
    await new CodexHookService().installRemote(sftp, REMOTE_HOME)
    const hooksJson = JSON.parse(fs.files.get(`${REMOTE_HOME}/.codex/hooks.json`)!) as {
      UserPromptSubmit?: { hooks?: { command?: string }[] }[]
    }
    const commands = JSON.stringify(hooksJson)
    expect(commands).toContain('exec /bin/sh')
    expect(commands).toContain(SCRIPT_PATH)
  })

  it('leaves the shared POSIX capture prelude unbounded for every other agent', () => {
    const defaultCapture = buildPosixHookPayloadCapture().join('\n')
    expect(defaultCapture).not.toContain('orca_hook_stdin_watchdog')
    expect(defaultCapture).toContain('payload=$({ command -p cat 2>/dev/null || cat; })')
  })

  it.skipIf(!hasPosixShell)(
    'dies on its own when the runner never closes stdin',
    async () => {
      const script = await generateCodexHookScript()

      const { status, signal, elapsedMs } = await runScriptWithStdin(script, 'never-close')

      // The watchdog SIGKILLs the script after the 8s capture budget; on Windows the exit
      // code surfaces as 9<<8 instead of a signal, so accept either shape of "killed".
      expect(signal === 'SIGKILL' || status === 137 || status === 2304 || status === 9).toBe(true)
      // The capture budget is 8s; anything near or past 20s is the old unbounded hang.
      expect(elapsedMs).toBeLessThan(15_000)
      expect(elapsedMs).toBeGreaterThanOrEqual(5_000)
    },
    25_000
  )

  it.skipIf(!hasPosixShell)(
    'still returns immediately with exit 0 when the runner closes stdin',
    async () => {
      const script = await generateCodexHookScript()

      const { status, signal, elapsedMs } = await runScriptWithStdin(script, 'close-empty')

      expect(status).toBe(0)
      expect(signal).toBeNull()
      // An immediately-closed stdin must not pay the watchdog budget.
      expect(elapsedMs).toBeLessThan(5_000)
    },
    20_000
  )
})
