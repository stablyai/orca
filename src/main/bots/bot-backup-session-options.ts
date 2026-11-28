import type { BotBackupModelEntry } from '../../shared/bots/bot-backup-models'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { mintAgentSessionOperationId } from '../runtime/orchestration/mailbox/structured-pointer/structured-pointer-operation-id'
import type { BotAppliedBackupOptions } from './bot-usage-limit-failover-execution'

export async function applySameAgentOptionsOnHost(
  sessionId: string,
  target: BotBackupModelEntry
): Promise<BotAppliedBackupOptions | null> {
  const host = getStructuredAgentSessionHost()
  const record = host?.deps.store.getRecord(sessionId)
  if (!host || !record) {
    return null
  }
  const caller = { callerKey: 'trusted-local:bot-backup-failover' }
  const writeOption = async (key: string, value: string): Promise<boolean> => {
    const latest = host.deps.store.getRecord(sessionId)
    if (!latest) {
      return false
    }
    const res = await host.setOption(caller, {
      envelope: {
        sessionId,
        clientOperationId: mintAgentSessionOperationId(Date.now()),
        expectedRuntimeFence: latest.lease.runtimeFence,
        payloadFingerprint: ''
      },
      key,
      value
    })
    return res.ok
  }
  // A same-agent switch without an explicit model would leave the exhausted model in place.
  if (!target.model || !(await writeOption('model', target.model))) {
    return null
  }
  const options: Record<string, string> = {}
  let complete = true
  for (const [key, value] of Object.entries(target.options ?? {})) {
    if (key === 'model') {
      continue
    }
    if (await writeOption(key, value).catch(() => false)) {
      options[key] = value
    } else {
      complete = false
    }
  }
  return {
    complete,
    target: {
      agent: target.agent,
      model: target.model,
      ...(Object.keys(options).length ? { options } : {})
    }
  }
}
