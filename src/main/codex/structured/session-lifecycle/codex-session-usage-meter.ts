import { createHash } from 'node:crypto'
import { readRecord } from '../../app-server/codex-item-field-readers'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { agentSessionUsageMeterSchema } from '../../../../shared/agent-session/agent-session-usage-meter'
import type { CodexSession } from './codex-structured-session-state'

const INCLUDED_PLANS = new Set(['pro', 'promax', 'plus', 'business', 'team', 'enterprise', 'edu'])

export function readCodexSessionUsageMeter(
  sessions: ReadonlyMap<string, CodexSession>,
  now: () => number
): NonNullable<StructuredAgentSessionAdapter['readUsageMeter']> {
  return async ({ sessionId, fence, signal }) => {
    const session = sessions.get(sessionId)
    const native = session?.nativeExecutionSettings
    const settings = session?.appliedSettings?.read()
    const counter = session?.usageMeter
    const usage = counter?.usage
    if (
      !session ||
      !native ||
      native.modelProvider !== 'openai' ||
      !settings ||
      native.model !== settings.model ||
      native.effort !== settings.effort ||
      !counter ||
      !usage ||
      session.authRevision === undefined
    ) {
      return null
    }
    const epoch = counter.epoch
    const activity = counter.activityRevision
    const revision = session.authRevision
    const generation = session.acquisitionGeneration
    const sequence = session.dispatchEchoes.latestSequence()
    const isCurrent = () =>
      !signal?.aborted &&
      sessions.get(sessionId) === session &&
      !session.ended &&
      !session.connection.closed &&
      session.fence === fence &&
      session.acquisitionGeneration === generation &&
      session.authRevision === revision &&
      session.nativeExecutionSettings === native &&
      session.appliedSettings?.read() === settings &&
      counter.epoch === epoch &&
      counter.activityRevision === activity &&
      counter.quiescent &&
      counter.usage === usage &&
      usage.threadId === session.threadId &&
      session.activeTurnIds !== undefined &&
      session.activeTurnIds.size === 0 &&
      !session.dispatchPending &&
      session.dispatchEchoes.latestSequence() === sequence &&
      (counter.origin !== 'fresh-thread' || sequence < 0)
    if (!isCurrent()) {
      return null
    }
    try {
      const reply = await session.connection.request(
        'account/read',
        { refreshToken: false },
        { timeoutMs: 2_000 }
      )
      const account = readRecord(readRecord(reply).account)
      const identity = account.id || account.email
      if (
        account.type !== 'chatgpt' ||
        typeof identity !== 'string' ||
        !identity.trim() ||
        identity.length > 512 ||
        typeof account.planType !== 'string' ||
        !INCLUDED_PLANS.has(account.planType) ||
        !isCurrent()
      ) {
        return null
      }
      const fingerprint = `codex:${createHash('sha256').update(identity.trim().toLowerCase()).digest('hex')}`
      const meterId = createHash('sha256')
        .update(
          JSON.stringify([
            sessionId,
            fence,
            generation,
            session.threadId,
            epoch,
            revision,
            fingerprint,
            account.planType,
            native.modelProvider,
            settings.model,
            settings.effort
          ])
        )
        .digest('hex')
      const parsed = agentSessionUsageMeterSchema.safeParse({
        version: 1,
        agent: 'codex',
        modelProvider: 'openai',
        sessionId,
        runtimeFence: fence,
        acquisitionGeneration: generation,
        observedAt: now(),
        model: settings.model,
        effort: settings.effort,
        meterId,
        scope: 'primary-thread',
        quiescent: true,
        origin: counter.origin,
        usage: { ...usage },
        account: { type: 'chatgpt', plan: account.planType, fingerprint }
      })
      return parsed.success && isCurrent() ? { meter: parsed.data, isCurrent } : null
    } catch {
      return null
    }
  }
}
