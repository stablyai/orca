import type { CommandHandler } from '../../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { writeStdoutLine } from '../../stdout-line'
import { ORCHESTRATION_EVENTS_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { resolveOrchestrationCliExecutable } from '../../runtime/orchestration-recovery-command'
import { runtimeLacks } from './older-runtime-run-binding'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

const WATCH_POLL_TIMEOUT_MS = 60_000

type EventsResult = { cursor: string; events: { type: string }[] }

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
    for (;;) {
      const response = await client.call<EventsResult>('orchestration.events', {
        runId,
        terminal,
        terminalPaneKey:
          terminal === undefined ? undefined : process.env.ORCA_PANE_KEY || undefined,
        types,
        sinceCursor: cursor,
        timeoutMs: WATCH_POLL_TIMEOUT_MS
      })
      for (const event of response.result.events) {
        writeStdoutLine(JSON.stringify(event))
      }
      cursor = response.result.cursor
      if (response.result.events.some((event) => event.type === 'end')) {
        return
      }
    }
  }
}
