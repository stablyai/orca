import {
  BrowserClientHostCommandResult,
  BrowserClientHostCommandResultAck,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostCommandResult as BrowserClientHostCommandResultType
} from '../../shared/browser-client-host-protocol'
import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'

export async function submitBrowserHostCommandResult(
  sendRequest: NonNullable<RemoteRuntimeSubscription['sendRequest']>,
  command: BrowserClientHostCommandEvent,
  candidate: BrowserClientHostCommandResultType,
  timeoutMs: number
): Promise<void> {
  const result = BrowserClientHostCommandResult.parse(candidate)
  const response = await sendRequest(
    'browser.clientHost.commandResult',
    {
      pageCommandProtocolVersion: command.pageCommandProtocolVersion,
      ...(command.pageReconciliationProtocolVersion
        ? { pageReconciliationProtocolVersion: command.pageReconciliationProtocolVersion }
        : {}),
      authorityRuntimeId: command.authorityRuntimeId,
      authorityEpoch: command.authorityEpoch,
      browserHostClientId: command.browserHostClientId,
      browserHostGeneration: command.browserHostGeneration,
      browserPageId: command.browserPageId,
      pageHostGeneration: command.pageHostGeneration,
      commandSequence: command.commandSequence,
      commandId: command.commandId,
      result
    },
    timeoutMs
  )
  if (!response.ok) {
    throw new RemoteRuntimeClientError(response.error.code, response.error.message)
  }
  if (
    response._meta.runtimeId !== command.authorityRuntimeId ||
    !BrowserClientHostCommandResultAck.safeParse(response.result).success
  ) {
    throw new Error('Invalid browser host command result acknowledgement')
  }
}
