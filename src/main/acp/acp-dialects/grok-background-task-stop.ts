import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { AcpDialect } from './acp-dialect'

const response = lazyZodSchema(() =>
  z.union([
    z.object({
      error: z.null().optional(),
      result: z.object({
        taskId: z.string(),
        outcome: z.enum(['killed', 'already_exited', 'not_found'])
      })
    }),
    z.object({ result: z.null(), error: z.string() })
  ])
)

export const grokBackgroundTaskStop: NonNullable<AcpDialect['backgroundTaskStop']> = {
  probe: { method: '_x.ai/task/kill', params: {} },
  lacksRoute: (error) => error.code === -32601,
  // Omit source to use Grok's per-task UI kill behavior.
  request: (sessionId, taskId) => ({ method: '_x.ai/task/kill', params: { sessionId, taskId } }),
  response: (value, taskId) => {
    const parsed = response.safeParse(value)
    if (!parsed.success || (parsed.data.result && parsed.data.result.taskId !== taskId)) {
      throw new Error('Grok returned an invalid background task kill response')
    }
    const { result } = parsed.data
    return !result ? 'refused' : result.outcome === 'killed' ? 'killed' : 'gone'
  }
}
