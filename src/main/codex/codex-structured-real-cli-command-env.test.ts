import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCodexCommand } from '../codex-cli/command'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { openCodexThread } from './codex-structured-thread-open'
import { codexStructuredPermissionPolicy } from './codex-structured-permission-policy'

// The probe is a POSIX shell command.
const enabled = process.env.ORCA_REAL_CODEX_CLI_TEST === '1' && process.platform !== 'win32'
const SESSION_ID = 'codex_real_command_env'
const PROBE = 'printf "probe[%s]" "$ORCA_AGENT_SESSION_ID"'

async function probeIdentity(
  base: string,
  thread: { resumeThreadId: string | null; commandEnv?: Record<string, string> }
): Promise<{ threadId: string; seen: string }> {
  let output = ''
  let turnCompleted = false
  const cwd = join(base, 'workspace')
  const connection = await openCodexAppServerConnection(
    {
      command: resolveCodexCommand(),
      args: ['app-server'],
      cwd,
      env: { HOME: base, CODEX_HOME: join(base, 'codex-home'), ORCA_AGENT_SESSION_ID: SESSION_ID }
    },
    {
      onNotification: (method, params) => {
        output += JSON.stringify(params)
        turnCompleted ||= method === 'turn/completed'
      }
    }
  )
  try {
    const opened = await openCodexThread(
      connection,
      { cwd, permissionPolicy: codexStructuredPermissionPolicy('ask'), ...thread },
      20_000
    )
    await connection.request(
      'thread/shellCommand',
      { threadId: opened.threadId, command: PROBE },
      { timeoutMs: 10_000 }
    )
    // Cold resume needs the rollout saved at turn completion.
    const deadline = Date.now() + 15_000
    while (!turnCompleted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const seen = output.match(/probe\[([^\]%]*)\]/)
    return { threadId: opened.threadId, seen: seen?.[1] ?? '<no output>' }
  } finally {
    await connection.close()
  }
}

describe.skipIf(!enabled)('Codex real app-server command env', () => {
  it('keeps the chat identity in commands under inherit = "core", on start and resume', async () => {
    const base = mkdtempSync(join(tmpdir(), 'orca-real-codex-env-'))
    try {
      mkdirSync(join(base, 'workspace'), { recursive: true })
      mkdirSync(join(base, 'codex-home'), { recursive: true })
      writeFileSync(
        join(base, 'codex-home', 'config.toml'),
        '[shell_environment_policy]\ninherit = "core"\n'
      )
      const commandEnv = { ORCA_AGENT_SESSION_ID: SESSION_ID }
      expect((await probeIdentity(base, { resumeThreadId: null })).seen).toBe('')
      const started = await probeIdentity(base, { resumeThreadId: null, commandEnv })
      expect(started.seen).toBe(SESSION_ID)
      const resumed = await probeIdentity(base, { resumeThreadId: started.threadId, commandEnv })
      expect(resumed).toEqual({ threadId: started.threadId, seen: SESSION_ID })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 120_000)
})
