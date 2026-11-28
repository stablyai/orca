import { useCallback, useEffect, useState } from 'react'
import * as z from 'zod'
import {
  bindDeferredRpcOperation,
  defineRpcOperation
} from '../../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../../transport/connection/connection-state'
import { useOptionalHostProtocolGates } from '../../../../components/host-connection/host-protocol-gates-context'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_PAIRED_WORKER_APPROVALS_RUNTIME_CAPABILITY
} from '../../../../../../src/shared/orchestration/orchestration-runtime-capabilities'
import {
  WorkerApprovalsFrame,
  type OrchestrationWorkerApprovalEntry
} from '../../../../../../src/shared/orchestration/orchestration-crew'
import type { MobilePairedServerAsks } from './use-mobile-paired-server-asks'
import type { WorkerApprovalDecision } from '../../../../../../src/shared/orchestration/approvals/worker-approval-payload'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../src/shared/agent-session/identity/orca-session-address'

export type MobileWorkerApproval = OrchestrationWorkerApprovalEntry

export type MobileWorkerApprovals = {
  /** Open prompts, oldest first. */
  open: readonly MobileWorkerApproval[]
  /** Closed ones, for their lines in the transcript; the same array until one changes. */
  receipts: readonly MobileWorkerApproval[]
  /** Resolves once the host took the answer; a prompt that closed meanwhile leaves on its own. */
  answer: (entry: MobileWorkerApproval, decision: WorkerApprovalDecision) => Promise<boolean>
  /** Asks from paired servers' agents to this chat's agent, answered in the same card slot. */
  pairedServerAsks?: MobilePairedServerAsks
}

// The person's own Deny: the worker gets this, word for word where its agent takes a message.
const OWNER_DENY_REASON = 'Denied by the owner.'
// Claude decides on its own once its countdown runs out; the host's closing report can lag it.
const LAPSE_GRACE_MS = 15_000
// The answer is the host's (`orchestration.approvalAnswer` is an orchestration write).
const ANSWER_OPTIONS = {
  timeoutMs: 15_000,
  envelope: { orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION }
}
const NONE: readonly MobileWorkerApproval[] = []
// Why 5 s: a host ends a stream rarely; reopen without hammering it.
const RETRY_MS = 5_000

const approvalAnswer = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'orchestration.approval-answer',
    method: 'orchestration.approvalAnswer',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('approval-answer', z.looseObject({ approvalId: z.string() }))
  })
)

const lapsed = ({ approval }: MobileWorkerApproval, now: number): boolean =>
  approval.expiresAt !== undefined && Date.parse(approval.expiresAt) + LAPSE_GRACE_MS <= now

/** A coordinator chat's workers' open permission prompts, from the host that runs the workers. */
export function useMobileWorkerApprovals({
  client,
  connState,
  sessionId,
  onAnswered,
  onAnswerError
}: {
  client: RpcClient | null
  connState: ConnectionState
  sessionId: string | null
  /** An accepted answer is an accepted chat write: it clears a held send error. */
  onAnswered?: () => void
  onAnswerError: (message: string) => void
}): MobileWorkerApprovals {
  // An older host would refuse the phone's Allow, so its prompts stay in the worker's pane.
  const supported =
    useOptionalHostProtocolGates()?.hostCapabilities.includes(
      ORCHESTRATION_PAIRED_WORKER_APPROVALS_RUNTIME_CAPABILITY
    ) === true
  const party = sessionId && isOrcaSessionId(sessionId) ? formatOrcaSessionAddress(sessionId) : null
  const [received, setReceived] = useState<readonly MobileWorkerApproval[]>(NONE)
  // Kept through a reconnect, so the transcript's lines don't blink; only this party's show.
  const [receipts, setReceipts] = useState<{
    party: string | null
    list: readonly MobileWorkerApproval[]
  }>({ party: null, list: NONE })
  const [now, setNow] = useState(() => Date.now())
  // Bumped to open a fresh stream after the host ended this one.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setReceived(NONE)
    if (!supported || !client || connState !== 'connected' || !party) {
      return
    }
    let pending: MobileWorkerApproval[] | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    const scheduleRetry = (): void => {
      pending = null
      setReceived(NONE)
      if (retry === undefined) {
        retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS)
      }
    }
    const stop = client.subscribe('orchestration.workerApprovalsSubscribe', { party }, (raw) => {
      const streamError = StreamErrorFrame.safeParse(raw)
      if (streamError.success) {
        const code = streamError.data.error?.code
        if (code !== 'method_not_found' && code !== 'forbidden') {
          scheduleRetry()
        } else {
          pending = null
          setReceived(NONE)
        }
        return
      }
      const parsed = WorkerApprovalsFrame.safeParse(raw)
      if (!parsed.success) {
        return
      }
      const frame = parsed.data
      if (frame.type === 'begin') {
        pending = []
      } else if (frame.type === 'approval') {
        pending?.push(frame.entry)
      } else if (frame.type === 'complete' && pending) {
        // A prompt Orca can't answer would hold the card and hide the ones behind it.
        const next = pending.filter(
          ({ approval }) => approval.state === 'open' && approval.allowedActions.length > 0
        )
        // Only its terminal can answer a terminal-only one: no line for it, as the desktop pins it.
        const closed = pending.filter(
          ({ approval }) => approval.state !== 'open' && approval.outcome?.by !== 'terminal-only'
        )
        pending = null
        setReceived(next.length ? next : NONE)
        setReceipts((current) =>
          current.party === party && sameReceipts(current.list, closed)
            ? current
            : { party, list: closed.length ? closed : NONE }
        )
      } else if (frame.type === 'end') {
        // The list it sent is no longer kept current.
        scheduleRetry()
      }
    })
    return () => {
      clearTimeout(retry)
      stop()
    }
  }, [attempt, client, connState, party, supported])

  // Drop a prompt once its countdown has run out, as the desktop does.
  const nextLapse = Math.min(
    ...received
      .map(({ approval }) =>
        approval.expiresAt ? Date.parse(approval.expiresAt) + LAPSE_GRACE_MS : Infinity
      )
      .filter((at) => at > now)
  )
  useEffect(() => {
    if (!Number.isFinite(nextLapse)) {
      return
    }
    // At least the deadline, so a clock stepped back can't strand the prompt.
    const timer = setTimeout(
      () => setNow(Math.max(Date.now(), nextLapse)),
      Math.max(0, nextLapse - Date.now())
    )
    return () => clearTimeout(timer)
  }, [nextLapse])

  const answer = useCallback(
    async (entry: MobileWorkerApproval, decision: WorkerApprovalDecision): Promise<boolean> => {
      if (!client) {
        return false
      }
      try {
        approvalAnswer.interpret(
          await approvalAnswer.request(
            client,
            {
              dispatch: entry.approval.worker.dispatchId,
              prompt: entry.approval.approvalId,
              decision,
              ...(decision === 'deny' ? { reason: OWNER_DENY_REASON } : {})
            },
            ANSWER_OPTIONS
          )
        )
        onAnswered?.()
        return true
      } catch (error) {
        onAnswerError(error instanceof Error ? error.message : String(error))
        return false
      }
    },
    [client, onAnswered, onAnswerError]
  )

  const open = received.some((entry) => lapsed(entry, now))
    ? received.filter((entry) => !lapsed(entry, now))
    : received
  return { open, receipts: receipts.party === party ? receipts.list : NONE, answer }
}

const StreamErrorFrame = z.looseObject({
  type: z.literal('error'),
  error: z.looseObject({ code: z.string().optional() }).optional()
})

// A new frame repeats every closed prompt; a line redraws only when its answer changes.
function sameReceipts(
  current: readonly MobileWorkerApproval[],
  next: readonly MobileWorkerApproval[]
): boolean {
  return (
    current.length === next.length &&
    current.every(
      ({ approval, at }, index) =>
        approval.approvalId === next[index]?.approval.approvalId &&
        approval.outcome?.by === next[index].approval.outcome?.by &&
        approval.outcome?.decision === next[index].approval.outcome?.decision &&
        at === next[index].at
    )
  )
}
