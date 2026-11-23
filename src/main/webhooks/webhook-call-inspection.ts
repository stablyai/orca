// What `orca webhooks calls --call` and `orca webhooks check` read of a hook's calls in the cloud.
import {
  matchesWebhookCall,
  type WebhookFilters
} from '../../../cloud/packages/connector-contract/src/webhook-matcher'
import { fenceQuotedText } from '../../shared/quoted-text-fence'
import type { WebhookCallText, WebhookCheckResult } from '../../shared/rpc-contract/webhooks-params'
import { webhookCallView } from './webhook-call-file'
import { webhookReadValue, type WebhookCloudCalls } from './webhook-cloud-routes'

// The two reads these make.
type CallReads = Pick<WebhookCloudCalls, 'calls' | 'envelope'>

const CHECK_CALLS = 50
const CHECK_FETCHES_AT_ONCE = 4

// An older cloud records no reason.
function ignoredCallText(reason: string | undefined): string {
  const why = reason ? `. ${reason}` : " by the hook's filters when it came in"
  return `This call was ignored${why}. Orca keeps no body for an ignored call.`
}

export async function webhookCallText(
  routes: CallReads,
  hookId: string,
  callId: string
): Promise<WebhookCallText> {
  const envelope = await routes.envelope(callId)
  if (envelope && !envelope.ok && envelope.status === 404) {
    const { calls } = webhookReadValue(await routes.calls(hookId))
    const row = calls.find((call) => call.kind === 'call' && call.callId === callId)
    if (row?.kind === 'call' && row.state === 'ignored') {
      return { callId, ignored: true, text: ignoredCallText(row.reason) }
    }
  }
  return { callId, text: fenceQuotedText(JSON.stringify(webhookReadValue(envelope), null, 2)) }
}

export async function checkWebhookCalls(
  routes: CallReads,
  hookId: string,
  filters: WebhookFilters
): Promise<WebhookCheckResult> {
  const { calls } = webhookReadValue(await routes.calls(hookId))
  const recent = calls.flatMap((row) => (row.kind === 'call' ? [row] : [])).slice(0, CHECK_CALLS)
  // An ignored call has no body, so it is never fetched; it counts as unknown too, all an older CLI
  // shows.
  const ignored = recent.filter((row) => row.state === 'ignored').length
  const ids = recent.flatMap((row) => (row.state === 'ignored' ? [] : [row.callId]))
  const result: WebhookCheckResult = { matched: 0, unmatched: 0, unknown: ignored, ignored }
  for (let index = 0; index < ids.length; index += CHECK_FETCHES_AT_ONCE) {
    const envelopes = await Promise.all(
      ids.slice(index, index + CHECK_FETCHES_AT_ONCE).map(async (id) => await routes.envelope(id))
    )
    for (const envelope of envelopes) {
      if (!envelope?.ok || envelope.value.truncated) {
        result.unknown++
      } else if (matchesWebhookCall(filters, webhookCallView(envelope.value))) {
        result.matched++
      } else {
        result.unmatched++
      }
    }
  }
  return result
}
