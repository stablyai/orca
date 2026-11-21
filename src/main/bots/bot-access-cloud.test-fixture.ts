import { vi } from 'vitest'
import type { ConnectorAccessRequest } from '../../shared/connector-bot-access-contract'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'

type Reply =
  | { ok: true; value: unknown }
  | { ok: false; status: number | null; error: string | null }

/** A cloud that answers the access-request routes from these requests; a saved grant moves one to granted. */
export function fakeAccessCloud(
  requests: ConnectorAccessRequest[],
  replies: { redeem?: Reply; decide?: Reply } = {}
) {
  let waiting = requests
  let granted: ConnectorAccessRequest[] = []
  const decisions: { path: string; body: unknown }[] = []
  const call = vi.fn(async (path: string, body: unknown) => {
    const failed = (reply: Reply) => ({ ...reply, retryAfterMs: null })
    if (path.endsWith('/redeem')) {
      return failed(replies.redeem ?? { ok: true, value: requests[0] })
    }
    if (path.endsWith('/decision')) {
      decisions.push({ path, body })
      const reply = replies.decide ?? { ok: true, value: undefined }
      if (reply.ok) {
        const requestId = decodeURIComponent(path.split('/').at(-2) ?? '')
        const answered = waiting.filter((request) => request.requestId === requestId)
        waiting = waiting.filter((request) => request.requestId !== requestId)
        if (
          typeof body === 'object' &&
          body !== null &&
          'decision' in body &&
          body.decision === 'granted'
        ) {
          granted = [...granted, ...answered]
        }
      }
      return failed(reply)
    }
    return { ok: true, value: { requests: waiting, granted } }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host calls only `call`, which this fake answers for the access routes.
  return { cloud: { call } as unknown as Pick<ConnectorCloud, 'call'>, call, decisions }
}
