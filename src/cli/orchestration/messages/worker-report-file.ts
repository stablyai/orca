import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { RuntimeClient } from '../../runtime/client'
import { RuntimeClientError } from '../../runtime/connection/types'
import { WORKER_REPORT_FILES_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRequestSelection } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { WorkerReportFile } from '../../../shared/orchestration/workers/worker-report-file'

export async function readWorkerReport(
  client: RuntimeClient,
  messageId: string,
  scope: { terminal?: string; run?: string } = {}
) {
  const result = await client.call<{ reportFile?: WorkerReportFile }>('orchestration.inbox', {
    report: messageId,
    ...scope
  })
  if (result.result.reportFile?.messageId !== messageId) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Update Orca on the mailbox host to read a captured report by message ID.'
    )
  }
  const file = result.result.reportFile
  if (
    createHash('sha256').update(Buffer.from(file.contentBase64, 'base64')).digest('hex') !==
    file.sha256
  ) {
    throw new RuntimeClientError(
      'invalid_report',
      'The stored report bytes do not match their SHA-256 digest.'
    )
  }
  return { ...result, result: file }
}

const SendReceipt = z.union([
  z.object({ message: z.object({ id: z.string(), payload: z.string().nullable() }) }),
  z.object({ relay: z.object({ reportContentBase64: z.string().optional() }) })
])

/** Rebuild the original keyed request from its receipt, even if the worker folder is gone. */
export async function reportReplay(client: RuntimeClient, request: string) {
  const shown = await client.call<{ state: string; receipt?: unknown }>(
    'orchestration.requestShow',
    { request }
  )
  if (shown.result.state === 'absent') {
    throw new RuntimeClientError(
      'retry_not_replayable',
      'This report has no retained receipt. Inspect the Dispatch before submitting another report.'
    )
  }
  if (shown.result.state !== 'completed') {
    return
  }
  const receipt = SendReceipt.safeParse(shown.result.receipt)
  if (!receipt.success) {
    throw new RuntimeClientError('request_mismatch', 'This request did not record a worker report.')
  }
  const sent = receipt.data
  if ('relay' in sent) {
    return { contentBase64: sent.relay.reportContentBase64 }
  }
  const payload = z
    .object({ reportSha256: z.string().optional() })
    .parse(JSON.parse(sent.message.payload ?? '{}'))
  // Replay a receipt from before file capture with its original path-only payload.
  if (!payload.reportSha256) {
    return {}
  }
  return { contentBase64: (await readWorkerReport(client, sent.message.id)).result.contentBase64 }
}

export function reportFileRecipient(params: unknown): RuntimeRequestSelection {
  return {
    paramsForStatus(status) {
      const host = z.object({ capabilities: z.array(z.string()) }).safeParse(status)
      if (!host.success || !host.data.capabilities.includes(WORKER_REPORT_FILES_CAPABILITY)) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'Update the worker runtime to capture --report-path. Nothing was sent.',
          { requestSent: false, effectsApplied: false }
        )
      }
      return params
    }
  }
}
