import { expect } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { RpcDispatcher } from '../../../rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../../../rpc/methods/orchestration/orchestration'
import {
  TERMINAL_HANDLE,
  PANE_KEY,
  LAUNCH_TOKEN
} from './orchestration-mailbox-notification-test-harness'

export type MailboxCheckResult = {
  runId: string
  dispatchId?: string
  deliveryId: string | null
  count: number
  messages: unknown[]
  acknowledged?: string | null
}

export type MailboxCheckOptions = {
  ack?: string
  wait?: boolean
  terminal?: string
  paneKey?: string
  launchToken?: string
  types?: string
  signal?: AbortSignal
}

export async function checkBoundMailbox(
  runtime: OrcaRuntimeService,
  options: MailboxCheckOptions = {}
): Promise<MailboxCheckResult> {
  const response = await dispatchMailboxCheck(runtime, options)
  expect(response.ok).toBe(true)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as MailboxCheckResult
}

export async function dispatchMailboxCheck(
  runtime: OrcaRuntimeService,
  options: MailboxCheckOptions = {}
) {
  const terminal = options.terminal ?? TERMINAL_HANDLE
  return new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }).dispatch(
    {
      id: 'req-mailbox-consistency',
      authToken: 'test-auth-token',
      method: 'orchestration.check',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationCompatibilityEvidence: {
        terminalHandle: terminal,
        paneKey: options.paneKey ?? PANE_KEY,
        launchToken: options.launchToken ?? LAUNCH_TOKEN
      },
      params: {
        terminal,
        ...(options.types ? { types: options.types } : {}),
        ...(options.ack ? { ack: options.ack } : {}),
        ...(options.wait ? { wait: true, timeoutMs: 5_000 } : {})
      }
    },
    { signal: options.signal }
  )
}
