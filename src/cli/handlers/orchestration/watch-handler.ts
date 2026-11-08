import type { CommandHandler } from '../../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { writeStdoutLine } from '../../stdout-line'
import { ORCHESTRATION_EVENTS_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { resolveOrchestrationCliExecutable } from '../../runtime/orchestration-recovery-command'
import { runtimeLacks } from './older-runtime-run-binding'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

const WATCH_POLL_TIMEOUT_MS = 60_000
const WATCH_RETRY_MAX_MS = 30_000
// Long-poll admission was full or a poll outlived the transport timeout; the cursor stays valid.
const RETRIABLE_CODES = new Set(['runtime_busy', 'runtime_timeout'])

type EventsResult = { cursor: string; events: { type: string; reason?: string }[] }

export const ORCHESTRATION_WATCH_HANDLER: Record<string, CommandHandler> = {
  'orchestration watch': async ({ flags, client, cwd }) => {
    const runId = getRequiredStringFlag(flags, 'run')
    const types = getOptionalStringFlag(flags, 'types')
      ?.split(',')
      .map((type) => type.trim())
      .filter(Boolean)
    if (await runtimeLacks(client, ORCHESTRATION_EVENTS_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        `This Orca server is an older version without orchestration events. Update it, or wait for mail with \`${resolveOrchestrationCliExecutable()} orchestration check --peek --wait --json\`.`
      )
    }
    const terminal = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'terminal')
    let cursor = getOptionalStringFlag(flags, 'since')
    // A closed reader (watch | head) ends the watch quietly.
    process.stdout.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        throw error
      }
      process.exit(0)
    })
    let retryMs = 0
    for (;;) {
      let result: EventsResult
      try {
        result = (
          await client.call<EventsResult>('orchestration.events', {
            runId,
            terminal,
            terminalPaneKey:
              terminal === undefined ? undefined : process.env.ORCA_PANE_KEY || undefined,
            types,
            sinceCursor: cursor,
            timeoutMs: WATCH_POLL_TIMEOUT_MS
          })
        ).result
      } catch (error) {
        if (!(error instanceof RuntimeClientError)) {
          throw error
        }
        if (error.code === 'consumer_fenced') {
          writeStdoutLine(JSON.stringify({ type: 'end', reason: 'consumer_fenced' }))
          process.exitCode = 1
          return
        }
        if (!RETRIABLE_CODES.has(error.code)) {
          throw cursor
            ? new RuntimeClientError(
                error.code,
                `${error.message} Resume with --since ${cursor}.`,
                error.data
              )
            : error
        }
        retryMs = Math.min(retryMs * 2 || 1_000, WATCH_RETRY_MAX_MS)
        await new Promise((resolve) => setTimeout(resolve, retryMs))
        continue
      }
      retryMs = 0
      for (const event of result.events) {
        writeStdoutLine(JSON.stringify(event))
      }
      cursor = result.cursor
      const end = result.events.find((event) => event.type === 'end')
      if (end) {
        if (end.reason === 'consumer_fenced') {
          process.exitCode = 1
        }
        return
      }
    }
  }
}
