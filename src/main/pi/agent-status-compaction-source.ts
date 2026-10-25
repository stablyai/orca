import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** Pi compacts between a finished reply's agent_end and its settle; stamping that compaction
 *  with the reply's finish lets the host announce it before the compaction ends. */
export function getPiAgentStatusCompactionHandlerSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    '  // Why: set only from a finished reply until its settle post, so a later /compact names no old turn.',
    '  let replyFinishedAt: number | undefined',
    '',
    '  function takeCompletedReplyFields(): Record<string, unknown> {',
    '    const fields = replyFinishedAt === undefined ? {} : { turn_completed_at: replyFinishedAt }',
    '    replyFinishedAt = undefined',
    '    return fields',
    '  }',
    '',
    '  // Why: a run cut off mid-tool, failed or aborted has no finished reply to announce.',
    '  function recordReplyFinish(event): void {',
    '    let reply: { stopReason?: unknown } | undefined',
    '    for (const message of Array.isArray(event?.messages) ? event.messages : []) {',
    "      if (message?.role === 'assistant') reply = message",
    '    }',
    "    const finished = reply?.stopReason === 'stop' || reply?.stopReason === 'length'",
    '    replyFinishedAt = finished && !isOmpRuntime() ? Date.now() : undefined',
    '  }',
    '',
    "  onStatus('session_before_compact', (event, ctx) => {",
    '    if (replyFinishedAt === undefined || isHeldByChildren()) return',
    // Why: overflow recovery retries the turn and queued messages continue it after the compaction.
    "    if (event?.willRetry === true || event?.reason === 'overflow') return",
    "    if (typeof ctx?.hasPendingMessages === 'function' && ctx.hasPendingMessages()) return",
    "    post('compaction_start', { turn_completed_at: replyFinishedAt })",
    '  })',
    ''
  ]
}
