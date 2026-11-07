import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  followLegacyGeneratedInputWrite,
  type GeneratedInputReplyObserver
} from '../runtime/generated-agent-input-notices-ingress'
import type { GeneratedInputNoticeOwner } from '../runtime/generated-agent-input-notices'
import { observeRemoteRuntimeRequestDispatch } from '../../shared/remote-runtime/requests/remote-runtime-request-dispatch-observation'
import type { KnownRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import { generatedInputNoticeOwnerOf } from './runtime-environments/runtime-environment-generated-input-notice-hosts'

/** A window's call for its accepted generated request, on its way to a paired host: the request
 *  itself, held as that window's pending record (with the host it runs on) before the request is
 *  prepared, one frame of an older host's write of it, or the ordinary status call choosing its
 *  route. The observer is told when the request's own frame actually leaves; `pairingRevision` is
 *  the pairing the request was first resolved to here, which every call of it is held to. */
export type RemoteGeneratedInputIngress = (
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  environment: KnownRuntimeEnvironment,
  call: {
    method: string
    params?: unknown
    generatedInputOperationId?: string
    expectedEnvironmentPairingRevision?: number
  }
) => { observer: GeneratedInputReplyObserver | null; pairingRevision?: number } | null

// The logical desktop window, stable across its renderer's reloads.
export const noticeOriginOf = (sender: WebContents): string => `desktop-window:${sender.id}`

/** The window's accepted generated request as main's routing receives it for a paired host. */
export function remoteGeneratedInputIngress(
  runtime: OrcaRuntimeService,
  acceptGeneratedInput: (
    sender: WebContents,
    method: string,
    params: unknown,
    owner?: GeneratedInputNoticeOwner,
    operationId?: string
  ) => GeneratedInputReplyObserver | null
): RemoteGeneratedInputIngress {
  // A private copy is kept only for the window's current document, as local calls require.
  return (event, environment, call) => {
    if (event.senderFrame !== event.sender.mainFrame) {
      return null
    }
    const origin = noticeOriginOf(event.sender)
    const current = generatedInputNoticeOwnerOf(environment)
    const id = call.generatedInputOperationId ?? retainedOperationIdOf(call.params)
    // The renderer's own capture when it had one, else this first resolution; never a later one.
    const pairingRevision = id
      ? runtime.generatedInputNotices.pinRoute(id, origin, {
          environmentId: environment.id,
          pairingRevision: call.expectedEnvironmentPairingRevision ?? current.pairingRevision!
        })
      : undefined
    const observer =
      call.method === 'terminal.send' && call.generatedInputOperationId
        ? followLegacyGeneratedInputWrite(
            runtime.generatedInputNotices,
            call.generatedInputOperationId,
            origin
          )
        : acceptGeneratedInput(
            event.sender,
            call.method,
            call.params,
            pairingRevision === undefined ? current : { ...current, pairingRevision },
            call.generatedInputOperationId
          )
    if (observer) {
      observeRemoteRuntimeRequestDispatch(call.params, observer.dispatched)
    }
    return { observer, ...(pairingRevision === undefined ? {} : { pairingRevision }) }
  }
}

function retainedOperationIdOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined
  }
  const operationId = 'operationId' in params ? params.operationId : undefined
  return 'retainNotice' in params && params.retainNotice === true && typeof operationId === 'string'
    ? operationId
    : undefined
}
