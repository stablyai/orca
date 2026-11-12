import { readRecord } from '../../app-server/codex-item-field-readers'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'

export async function assertCodexExecutionCapacity(session: CodexSession): Promise<void> {
  const policy = session.execution!.policy
  const call = (method: string, params: Record<string, unknown>) =>
    session.connection.request(method, params, { timeoutMs: 2_000 })
  const limits = readRecord(readRecord(await call('account/rateLimits/read', {})).rateLimits)
  const windows = ['primary', 'secondary']
    .map((key) => limits[key])
    .filter((value) => value !== null && value !== undefined)
  if (
    !windows.length ||
    windows.some((value) => {
      const window = readRecord(value)
      return (
        typeof window.usedPercent !== 'number' ||
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        window.usedPercent >= 100 ||
        typeof window.resetsAt !== 'number' ||
        !Number.isSafeInteger(window.resetsAt) ||
        window.resetsAt * 1000 <= Date.now()
      )
    })
  ) {
    throw new Error('Included Codex capacity unavailable.')
  }
  let cursor: string | undefined
  const cursors = new Set<string>()
  for (let page = 0; page < 20; page++) {
    const result = readRecord(
      await call('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) })
    )
    if (!Array.isArray(result.data)) {
      break
    }
    for (const entry of result.data) {
      const model = readRecord(entry)
      if (
        model.model === policy.model &&
        Array.isArray(model.supportedReasoningEfforts) &&
        model.supportedReasoningEfforts.some(
          (value) => readRecord(value).reasoningEffort === policy.effort
        )
      ) {
        return
      }
    }
    if (
      typeof result.nextCursor !== 'string' ||
      !result.nextCursor ||
      cursors.has(result.nextCursor)
    ) {
      break
    }
    cursor = result.nextCursor
    cursors.add(cursor)
  }
  throw new Error('Admitted Codex model and effort unavailable.')
}
