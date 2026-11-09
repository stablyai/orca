import {
  BrowserClientHostCommandResultAck,
  type BrowserClientHostCommandEvent
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import {
  BrowserClientAutomationResult as BrowserClientHostCommandResult,
  type BrowserClientAutomationResult as BrowserClientHostCommandResultType
} from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type { RemoteRuntimeTransportSubscription } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'

export async function submitBrowserHostCommandResult(
  sendRequest: NonNullable<RemoteRuntimeTransportSubscription['sendRequest']>,
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
