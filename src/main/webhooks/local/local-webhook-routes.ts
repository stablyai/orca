// The routes a host's webhooks use, answered by this host itself while local webhooks are on: the
// same calls and answers as Orca Cloud's (webhook-cloud-routes.ts), from the local store.
import type { ConnectorResult } from '../../connector-cloud/connector-cloud-request'
import type { WebhookCloudCalls } from '../webhook-cloud-routes'
import type { LocalCall, LocalHook, LocalWebhookStore } from './local-webhook-store'

/** Signatures (setSecret) are not checked by local webhooks yet; the key alone admits a call. */
export const LOCAL_SIGNATURES_UNSUPPORTED = 'local_webhook_signatures_unsupported'

const answer = <T>(value: T): ConnectorResult<T> => ({ ok: true, value })
const refuse = <T>(status: number, error: string): ConnectorResult<T> => ({
  ok: false,
  status,
  error,
  retryAfterMs: null
})

const SAMPLE_BODY = { sample: true, text: 'A sample call from Orca.' }

export type LocalWebhookRoutesDeps = {
  store: LocalWebhookStore
  /** The listener's base URL, read on every answer so a changed Public URL shows at once. */
  baseUrl: () => string
  /** Hands a call to this host's webhooks, as a trigger delivery would. */
  deliver: (hook: LocalHook, call: LocalCall) => Promise<unknown>
  now?: () => number
}

export function localWebhookCalls(deps: LocalWebhookRoutesDeps): WebhookCloudCalls {
  const { store } = deps
  const now = deps.now ?? Date.now
  const withHook = async <T>(
    hookId: string,
    act: (hook: LocalHook) => Promise<ConnectorResult<T>>
  ): Promise<ConnectorResult<T>> => {
    const hook = await store.hook(hookId)
    return hook ? await act(hook) : refuse(404, 'not_found')
  }
  const view = (hook: LocalHook) => store.view(hook, deps.baseUrl())
  const sampling = new Map<string, Promise<LocalCall>>()
  const sampleCall = async (hook: LocalHook, operationId: string): Promise<LocalCall> => {
    const made = await store.sampleCall(operationId)
    if (made) {
      // A repeat delivers a sample whose first delivery failed; the host takes a known call once.
      if (made.state === 'queued') {
        await deps.deliver(hook, made)
      }
      return made
    }
    const receivedAt = now()
    const call = await store.admit(
      hook,
      { receivedAt, state: 'queued', sample: true, sampleOperationId: operationId },
      {
        receivedAt,
        contentType: 'application/json',
        headers: { 'content-type': 'application/json' },
        body: { kind: 'json', value: SAMPLE_BODY },
        truncated: false
      }
    )
    // Null only for a sender's key a rotation ended (a sample names none), or a full queue.
    if (!call || call === 'queue_full') {
      throw new Error('the sample call was not taken')
    }
    await deps.deliver(hook, call)
    return call
  }
  return {
    mint: async ({ operationId, automationId, botId }) =>
      answer(await view(await store.mint(operationId, automationId, botId))),
    list: async (botId) =>
      answer({ hooks: await Promise.all((await store.hooks(botId)).map(view)) }),
    get: (hookId) => withHook(hookId, async (hook) => answer(await view(hook))),
    setState: (hookId, { state }) =>
      withHook(hookId, async (hook) => {
        const changed = await store.setState(hook.hookId, state)
        return changed ? answer(await view(changed)) : refuse(404, 'not_found')
      }),
    remove: (hookId) =>
      withHook(hookId, async () => {
        await store.remove(hookId)
        return answer(undefined)
      }),
    reveal: (hookId) => withHook(hookId, async (hook) => answer({ key: hook.key })),
    rotate: (hookId, { operationId, stopNow }) =>
      withHook(hookId, async () => {
        const cancelledCalls = await store.rotate(hookId, operationId, stopNow)
        return cancelledCalls === null ? refuse(404, 'not_found') : answer({ cancelledCalls })
      }),
    setSecret: (hookId) => withHook(hookId, async () => refuse(400, LOCAL_SIGNATURES_UNSUPPORTED)),
    sample: (hookId, operationId) =>
      withHook(hookId, async (hook) => {
        // One sample per operation, also for a repeat that overlaps the first.
        let made = sampling.get(operationId)
        if (!made) {
          made = sampleCall(hook, operationId).finally(() => sampling.delete(operationId))
          sampling.set(operationId, made)
        }
        return answer({ callId: (await made).callId })
      }),
    calls: (hookId) => withHook(hookId, async () => answer({ calls: await store.history(hookId) })),
    envelope: async (callId) => {
      const envelope = await store.envelope(callId)
      return envelope ? answer(envelope) : refuse(404, 'not_found')
    },
    start: async (callId, runId) => {
      const started = await store.start(callId, runId)
      if (started === 'another_run') {
        return refuse(409, 'started_for_another_run')
      }
      return started === 'started'
        ? answer({ started: true as const, runId })
        : refuse(410, 'settled')
    }
  }
}

/** The local routes while local webhooks are on, else the cloud's; picked on every call. */
export function switchedWebhookCalls(
  cloud: WebhookCloudCalls,
  local: () => WebhookCloudCalls | null
): WebhookCloudCalls {
  const pick = () => local() ?? cloud
  return {
    mint: (body) => pick().mint(body),
    list: (botId) => pick().list(botId),
    get: (hookId) => pick().get(hookId),
    setState: (hookId, body) => pick().setState(hookId, body),
    remove: (hookId) => pick().remove(hookId),
    reveal: (hookId, body) => pick().reveal(hookId, body),
    rotate: (hookId, body) => pick().rotate(hookId, body),
    setSecret: (hookId, body) => pick().setSecret(hookId, body),
    sample: (hookId, operationId) => pick().sample(hookId, operationId),
    calls: (hookId) => pick().calls(hookId),
    envelope: (callId) => pick().envelope(callId),
    start: (callId, runId) => pick().start(callId, runId)
  }
}
