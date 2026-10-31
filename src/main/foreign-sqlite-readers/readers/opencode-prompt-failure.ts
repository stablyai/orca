import { z } from 'zod'
import { usageLimitResetsAt } from '../../../shared/agent-session-usage-limit'
import { readOpenCodeDatabase } from '../../ai-vault/session-scanner-opencode-sqlite-open'
import { columnExists, tableExists } from '../../opencode-usage/schema-helpers'
import {
  openCodePromptFailureSchema,
  type OpenCodePromptFailureQuery,
  type OpenCodePromptFailureResult
} from '../opencode-prompt-failure-result'

const rowSchema = z.object({
  inputId: z.string(),
  type: z.string(),
  message: z.string(),
  status: z.number().nullable(),
  createdAt: z.number().int(),
  retryAfterMs: z.number().int().nonnegative().nullable().catch(null),
  response: z.string().nullable()
})
const responseSchema = z.object({
  error: z.object({ type: z.string().max(128), message: z.string().max(4096).optional() })
})

export function readOpenCodePromptFailure(
  query: OpenCodePromptFailureQuery
): OpenCodePromptFailureResult {
  return readOpenCodeDatabase({
    dbPath: query.dbPath,
    read: (db) => {
      const table = 'session_message'
      if (
        !tableExists(db, table) ||
        !['id', 'session_id', 'seq', 'type', 'data', 'time_created'].every((column) =>
          columnExists(db, table, column)
        )
      ) {
        return { failure: null }
      }
      // Require fresh input before the latest outcome; never borrow an earlier turn's failure.
      const row: unknown = db
        .prepare(
          `WITH input AS (
            SELECT id AS inputId, seq AS input_seq, time_created AS input_created FROM session_message
            WHERE session_id = ? AND type = 'user' ORDER BY seq DESC LIMIT 1
          ), outcome AS (
            SELECT seq, data, time_created FROM session_message
            WHERE session_id = ? AND type IN ('assistant', 'idle')
            ORDER BY seq DESC LIMIT 1
          ) SELECT
            inputId,
            CASE WHEN json_valid(data) THEN substr(json_extract(data, '$.error.type'), 1, 128) END AS type,
            CASE WHEN json_valid(data) THEN substr(json_extract(data, '$.error.message'), 1, 4096) END AS message,
            CASE WHEN json_valid(data) THEN json_extract(data, '$.error.status') END AS status,
            time_created AS createdAt,
            CASE WHEN json_valid(data) THEN json_extract(data, '$.error.retryAfterMs') END AS retryAfterMs,
            CASE WHEN json_valid(data) THEN substr(json_extract(data, '$.error.response.body'), 1, 16384) END AS response
          FROM outcome, input
          WHERE input_seq < seq AND input_created >= ? AND input_created <= ?
            AND time_created >= ? AND time_created <= ?`
        )
        .get(
          query.sessionId,
          query.sessionId,
          query.startedAt,
          query.failedAt,
          query.startedAt,
          query.failedAt
        )
      const parsed = rowSchema.safeParse(row)
      if (!parsed.success) {
        return { failure: null }
      }
      let response: z.infer<typeof responseSchema> | undefined
      if (parsed.data.response) {
        try {
          const decoded = responseSchema.safeParse(JSON.parse(parsed.data.response))
          if (decoded.success) {
            response = decoded.data
          }
        } catch {
          // An invalid response body does not invalidate the native error itself.
        }
      }
      const failure = openCodePromptFailureSchema.safeParse({
        inputId: parsed.data.inputId,
        type: parsed.data.type,
        message: parsed.data.message,
        ...(parsed.data.status === null ? {} : { status: parsed.data.status }),
        ...(parsed.data.retryAfterMs === null
          ? {}
          : {
              resetsAt: usageLimitResetsAt(
                parsed.data.createdAt + parsed.data.retryAfterMs,
                query.failedAt
              )
            }),
        ...(response
          ? { responseType: response.error.type, responseMessage: response.error.message }
          : {})
      })
      return { failure: failure.success ? failure.data : null }
    }
  })
}
