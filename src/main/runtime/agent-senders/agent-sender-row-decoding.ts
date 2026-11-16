import 'node:crypto'
import '../../../shared/orchestration/workers/structured-worker-handle'
import '../../../shared/workspace-layout/stable-pane-id'
import '../../../shared/orchestration/workers/worker-terminal-host-scope'
import 'zod'
import type { z } from 'zod'
import '../../../shared/agent-session/view/structured-agent-session-projection'
import '../orchestration/addressing/session-lineage/structured-session-lineage'
import '../../../shared/execution-host'

export const tolerant = <T>(schema: z.ZodType<T>, rows: unknown[]): T[] =>
  rows.flatMap((row) => {
    const parsed = schema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
