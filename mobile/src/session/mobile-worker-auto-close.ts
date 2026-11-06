import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { Timer } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { useOptionalHostProtocolGates } from '../components/host-protocol-gates-context'
import { ORCHESTRATION_WORKER_KEEP_OPEN_RUNTIME_CAPABILITY } from '../../../src/shared/orchestration-runtime-capabilities'
import {
  pollWorkerAutoClose,
  publishWorkerAutoClose,
  readPublishedWorkerAutoClose,
  readWorkerAutoCloseReply,
  subscribeWorkerAutoClose,
  type WorkerAutoCloseState
} from '../../../src/shared/worker-auto-close'
import type { MobileSessionTab } from './mobile-session-route-types'

export type MobileWorkerSubject = { terminal: string } | { sessionId: string }

export function workerSubjectOf(tab: MobileSessionTab | undefined): MobileWorkerSubject | null {
  if (tab?.type === 'agent-session') {
    return { sessionId: tab.sessionId }
  }
  return tab?.type === 'terminal' && typeof tab.terminal === 'string'
    ? { terminal: tab.terminal }
    : null
}

const autoCloseReplySchema = z.unknown().transform(readWorkerAutoCloseReply)

const workerAutoCloseRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'orchestration.worker-auto-close',
    method: 'orchestration.workerAutoClose',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worker-auto-close', autoCloseReplySchema)
  })
)

const workerKeepOpenSet = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'orchestration.worker-keep-open',
    method: 'orchestration.workerKeepOpen',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worker-keep-open', autoCloseReplySchema)
  })
)

const REQUEST_OPTIONS = { timeoutMs: 5_000, budgetSpansConnect: true }

export function readMobileWorkerAutoClose(
  client: RpcClient,
  subject: MobileWorkerSubject
): Promise<WorkerAutoCloseState | null> {
  return workerAutoCloseRead
    .request(client, subject, REQUEST_OPTIONS)
    .then((reply) => workerAutoCloseRead.interpret(reply) ?? null)
    .catch(() => null)
}

export function setMobileWorkerKeptOpen(
  client: RpcClient,
  subject: MobileWorkerSubject,
  keep: boolean
): Promise<WorkerAutoCloseState | null> {
  return workerKeepOpenSet
    .request(client, { ...subject, keep }, REQUEST_OPTIONS)
    .then((reply) => workerKeepOpenSet.interpret(reply) ?? null)
    .then((state) => {
      publishWorkerAutoClose(JSON.stringify(subject), state)
      return state
    })
}

// An older host lacks the methods, so it is never asked.
function useHostKeepsWorkersOpen(): boolean {
  return (
    useOptionalHostProtocolGates()?.hostCapabilities.includes(
      ORCHESTRATION_WORKER_KEEP_OPEN_RUNTIME_CAPABILITY
    ) === true
  )
}

/** The open tab's auto-close state from its host while connected, plus the clock its countdown ticks on. */
export function useMobileWorkerAutoClose(
  client: RpcClient | null,
  connState: ConnectionState,
  subject: MobileWorkerSubject | null
): { state: WorkerAutoCloseState | null; nowMs: number; keepOpen: () => void } {
  const supported = useHostKeepsWorkersOpen()
  const key = subject ? JSON.stringify(subject) : null
  const subscribe = useCallback(
    (listener: () => void) => subscribeWorkerAutoClose(key, listener),
    [key]
  )
  const state = useSyncExternalStore(subscribe, () => readPublishedWorkerAutoClose(key))
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!key || !client || connState !== 'connected' || !subject || !supported) {
      return
    }
    return pollWorkerAutoClose(
      () => readMobileWorkerAutoClose(client, subject),
      (next) => publishWorkerAutoClose(key, next)
    )
  }, [client, connState, key, supported])

  const ticking = state !== null && !state.kept && state.closesAt !== null
  useEffect(() => {
    if (!ticking) {
      return
    }
    setNowMs(Date.now())
    const interval = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [ticking])

  const keepOpen = useCallback(() => {
    if (key && client && subject) {
      publishWorkerAutoClose(key, { kept: true })
      void setMobileWorkerKeptOpen(client, subject, true).catch(() =>
        readMobileWorkerAutoClose(client, subject).then((next) => publishWorkerAutoClose(key, next))
      )
    }
  }, [client, key])

  return { state, nowMs, keepOpen }
}

/** For a long-pressed worker tab the user kept open: the sheet's Allow Auto-Close, else nothing. */
export function useMobileAllowAutoCloseActions(
  client: RpcClient | null,
  subject: MobileWorkerSubject | null
): ActionSheetAction[] {
  const t = useMobileTranslation()
  const supported = useHostKeepsWorkersOpen()
  const [kept, setKept] = useState<MobileWorkerSubject | null>(null)
  const key = subject ? JSON.stringify(subject) : null
  useEffect(() => {
    setKept(null)
    if (!client || !subject || !supported) {
      return
    }
    let cancelled = false
    void readMobileWorkerAutoClose(client, subject).then((state) => {
      if (!cancelled && state?.kept) {
        setKept(subject)
      }
    })
    return () => {
      cancelled = true
    }
  }, [client, key, supported])
  if (!client || !kept) {
    return []
  }
  return [
    {
      id: 'allowAutoClose',
      label: t('session.sheets.allowAutoClose', 'Allow Auto-Close'),
      icon: Timer,
      onPress: () => void setMobileWorkerKeptOpen(client, kept, false).catch(() => {})
    }
  ]
}
