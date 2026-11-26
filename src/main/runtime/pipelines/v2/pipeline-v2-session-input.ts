import type { PipelineStorePort } from '../pipeline-store-port'
import type { PipelineSessionBinding } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'

export type PipelineRawInputReceipt = {
  receiptId: string
  accepted: boolean
  uncertainDelivery?: boolean
  queryReply: boolean
  submitKeyOnly?: boolean
}
export async function observePipelineV2RawInput(
  store: PipelineStorePort,
  binding: PipelineSessionBinding,
  input: PipelineRawInputReceipt
): Promise<void> {
  await store.observeRawInput(binding, input)
}
