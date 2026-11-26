import type { PipelineStorePort } from '../pipeline-store-port'
import type { PipelineV2Invocation } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'

export async function pipelineV2DeliveryReceipt(
  store: PipelineStorePort,
  invocation: PipelineV2Invocation
) {
  if (invocation.state === 'uncertain' || !invocation.dispatchId || !invocation.session) {
    return undefined
  }
  const receipt = await store.launchReceiptV2(invocation.id)
  if (
    receipt?.state !== 'ready' ||
    receipt.dispatchId !== invocation.dispatchId ||
    !receipt.session ||
    pipelineV2Fingerprint(receipt.session) !== pipelineV2Fingerprint(invocation.session)
  ) {
    return undefined
  }
  return { ...receipt, message: invocation.message }
}

export async function pipelineV2RefusalReceipt(
  store: PipelineStorePort,
  invocation: PipelineV2Invocation
) {
  const receipt = await store.launchReceiptV2(invocation.id)
  if (
    invocation.state !== 'settled' ||
    invocation.dispatchId ||
    invocation.session ||
    receipt?.state !== 'not_started' ||
    !receipt.reason
  ) {
    return undefined
  }
  return { ...receipt, message: invocation.message }
}
