import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { splitGeneratedInputText } from '../../shared/generated-terminal-input'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay/mobile-desktop-relay-hosts'
import type {
  GeneratedAgentInputNotices,
  GeneratedInputNoticeAnswer,
  GeneratedInputNoticeCommand
} from './generated-agent-input-notices'

export type GeneratedInputNoticeHosts = Pick<
  MobileDesktopRelayHosts,
  'call' | 'onEnvironmentRetired'
> & {
  /** A host's connectivity changed: the one named, or any when the publication cannot say. */
  onStatusChanged: (listener: (environmentId?: string) => void) => () => void
  /** The user disconnected it: nothing is sent until they connect again. */
  isManuallyDisconnected: (environmentId: string) => boolean
}

// The host took the command, is proven another runtime or pairing ('stale'), answered that it
// never can ('refused'), or gave no usable answer, which only a later wake retries.
type Forwarded = GeneratedInputNoticeAnswer | 'unresolved'

const CALL_TIMEOUT_MS = 15_000
const resultSchema = z.object({
  part: z.literal('accepted').optional(),
  retained: z.boolean().optional(),
  dismissed: z.boolean().optional(),
  stale: z.literal(true).optional()
})

/** Delivers what this runtime's windows owe their paired hosts (a copy of a request's text whose
 *  answer was lost, or a discard) through the existing host calls, when work is owed and on each
 *  change in connectivity. Each host gets one attempt at a time; nothing is polled or timed per
 *  notice, and neither call can write to a terminal. An answer completes only the exact command
 *  it answers; work ends then, when the runtime or pairing it was meant for is gone, or with this
 *  runtime. */
export function forwardGeneratedInputNotices(
  notices: GeneratedAgentInputNotices,
  hosts: GeneratedInputNoticeHosts
): () => void {
  const { commands } = notices
  let stopped = false
  // Per host: wakes seen so far, so one that arrives during a failing call is never lost.
  const wakes = new Map<string, number>()
  const running = new Set<string>()
  // Stopping cancels every call in flight; nothing later is sent for this forwarder.
  const lifetime = new AbortController()
  const drain = async (environmentId: string): Promise<void> => {
    try {
      let seen: number | undefined
      while (!stopped && seen !== wakes.get(environmentId)) {
        seen = wakes.get(environmentId)
        for (const command of commands.owedTo(environmentId)) {
          // Only while this forwarder lives and this exact command is still the one owed.
          const current = (): boolean => !stopped && commands.of(command.id) === command
          const answer = await forward(hosts, command, notices, current, lifetime.signal).catch(
            (): Forwarded => 'unresolved'
          )
          // A stopped or replaced forwarder completes nothing on behalf of its successor.
          if (stopped) {
            return
          }
          if (!current()) {
            continue
          }
          if (answer === 'unresolved') {
            break
          }
          notices.commandAnswered(command, answer)
        }
      }
    } finally {
      // In the same turn as the last check, so a wake arriving after it starts a new drain.
      running.delete(environmentId)
      wakes.delete(environmentId)
    }
  }

  const wake = (environmentId: string): void => {
    if (stopped || hosts.isManuallyDisconnected(environmentId)) {
      return
    }
    wakes.set(environmentId, (wakes.get(environmentId) ?? 0) + 1)
    if (running.has(environmentId)) {
      return
    }
    running.add(environmentId)
    void drain(environmentId)
  }
  commands.onOwed = wake
  // A named host's change wakes that host only, and only when it is owed work.
  const stopStatus = hosts.onStatusChanged((environmentId) => {
    if (environmentId !== undefined) {
      if (commands.isOwed(environmentId)) {
        wake(environmentId)
      }
      return
    }
    for (const owed of commands.environments()) {
      wake(owed)
    }
  })
  const stopRetired = hosts.onEnvironmentRetired((environmentId) =>
    notices.retireOwner(environmentId)
  )
  return () => {
    stopped = true
    lifetime.abort()
    stopStatus()
    stopRetired()
    if (commands.onOwed === wake) {
      commands.onOwed = null
    }
  }
}

async function forward(
  hosts: GeneratedInputNoticeHosts,
  command: GeneratedInputNoticeCommand,
  notices: GeneratedAgentInputNotices,
  current: () => boolean,
  signal: AbortSignal
): Promise<Forwarded> {
  const { owner } = command
  // Main fences the pairing; the receiving runtime itself refuses work meant for another one.
  const call = (method: string, params: Record<string, unknown>) =>
    hosts.call({ environmentId: owner.environmentId }, method, params, {
      timeoutMs: CALL_TIMEOUT_MS,
      signal,
      expected: { pairingRevision: owner.pairingRevision, runtimeId: null }
    })
  if (!current()) {
    return 'unresolved'
  }
  const fenced = { id: command.id, window: owner.window, authorityRuntimeId: owner.runtimeId }
  if (command.kind === 'discard') {
    return answer(await call('terminal.dismissGeneratedInputNotice', fenced), 'dismissed')
  }
  const notice = notices.noticeOf(command.id)
  if (!notice) {
    return 'refused'
  }
  const parts = splitGeneratedInputText(notice.text)
  const upload = randomUUID()
  let response: RuntimeRpcResponse<unknown> | null = null
  for (const [index, text] of parts.entries()) {
    // Superseded or stopped mid-upload: no later part is sent.
    if (index > 0 && !current()) {
      return 'unresolved'
    }
    response = await call('terminal.generatedInputNotices.register', {
      ...fenced,
      text,
      agent: notice.agent,
      certainty: notice.certainty,
      ...(notice.submitted === false ? { submitted: false } : {}),
      ...(owner.terminal ? { handle: owner.terminal } : {}),
      ...(parts.length > 1
        ? { part: { id: upload, index, final: index === parts.length - 1 } }
        : {})
    })
    if (!response.ok || resultSchema.safeParse(response.result).data?.part !== 'accepted') {
      break
    }
  }
  return answer(response!, 'retained')
}

function answer(response: RuntimeRpcResponse<unknown>, kept: 'retained' | 'dismissed'): Forwarded {
  if (!response.ok) {
    // Another runtime or pairing now answers under this environment: the work can never apply.
    return response.error.code === 'runtime_environment_changed' ? 'stale' : 'unresolved'
  }
  const result = resultSchema.safeParse(response.result)
  if (!result.success || result.data[kept] === undefined) {
    return 'unresolved'
  }
  if (result.data.stale) {
    return 'stale'
  }
  // A refusal (conflict, already discarded there, not this window's) keeps the local text as it is.
  return result.data[kept] ? 'held' : 'refused'
}
