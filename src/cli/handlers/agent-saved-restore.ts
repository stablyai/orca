import type { CommandHandler } from '../dispatch'
import { RuntimeRpcFailureError } from '../runtime-client'
import {
  SAVED_RESTORE_BUDGET_ENV,
  SAVED_RESTORE_FRESH_EXIT_CODE,
  SAVED_RESTORE_ROOT_KEYS
} from '../../shared/saved-restore-dispatch'

const MAX_BUDGET_MS = 10_000
const RETRY_MS = 100
// The completion report only shows a notice; it never holds the agent it reports on.
const DISPATCHED_TIMEOUT_MS = 5_000
const MAX_ARGS_BYTES = 1_048_576

async function readArgs(): Promise<string[] | null> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    if ((bytes += buffer.length) > MAX_ARGS_BYTES) {
      return null
    }
    chunks.push(buffer)
  }
  // Each argument ends with NUL; PowerShell appends a newline after the last one.
  const input = Buffer.concat(chunks).toString('utf8')
  const end = input.lastIndexOf('\0')
  return end === -1 ? [] : input.slice(0, end).split('\0')
}

export const AGENT_SAVED_RESTORE_HANDLERS: Record<string, CommandHandler> = {
  // Exit 75 alone means start fresh; every other outcome, including this command's absence in an
  // older Orca, runs the original resume. Always the local runtime: the pane's store is local.
  'agent saved-restore-check': async ({ client, flags }) => {
    const startedAt = Date.now() - process.uptime() * 1000
    const token = flags.get('token')
    const entry = flags.get('entry')
    if (typeof token !== 'string' || typeof entry !== 'string') {
      return
    }
    // The pane and launch come from this process's own env, never from the recalled line.
    const caller = {
      entry,
      paneKey: process.env.ORCA_PANE_KEY ?? null,
      launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN ?? null
    }
    if (flags.get('phase') === 'dispatched') {
      await client
        .call(
          'agentHooks.savedRestore',
          { phase: 'dispatched', token, ...caller },
          { timeoutMs: DISPATCHED_TIMEOUT_MS }
        )
        .catch(() => {})
      return
    }
    const agent = flags.get('agent')
    const budget = Math.min(Number(process.env[SAVED_RESTORE_BUDGET_ENV]) || 0, MAX_BUDGET_MS)
    const deadline = startedAt + budget
    const args = typeof agent === 'string' ? await readArgs() : null
    if (!args) {
      return
    }
    const roots = Object.fromEntries(
      SAVED_RESTORE_ROOT_KEYS.flatMap((key) => {
        const value = process.env[key]
        return value === undefined ? [] : [[key, value]]
      })
    )
    // Retried until the deadline: a restored pane's shell can start before the runtime listens.
    for (let remaining = deadline - Date.now(); remaining > 0; remaining = deadline - Date.now()) {
      try {
        const response = await client.call<{ fresh?: unknown }>(
          'agentHooks.savedRestore',
          {
            phase: 'check',
            token,
            ...caller,
            agent,
            args,
            roots,
            cwd: process.cwd(),
            remainingMs: Math.floor(remaining)
          },
          { timeoutMs: remaining }
        )
        if (response.result.fresh === true) {
          process.exitCode = SAVED_RESTORE_FRESH_EXIT_CODE
        }
        return
      } catch (error) {
        if (error instanceof RuntimeRpcFailureError) {
          return
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_MS, remaining)))
      }
    }
  }
}
