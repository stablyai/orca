export const WATERMARK_RECEIPT_SQL = `(
  (method = 'orchestration.federationAck' AND substr(request_id, 1, 10) = 'relay_ack_') OR
  (method = 'orchestration.federationImport' AND substr(request_id, 1, 13) = 'relay_import_')
)`

export function isWatermarkMutationReceipt(method: string, requestId: string): boolean {
  return (
    (method === 'orchestration.federationAck' && requestId.startsWith('relay_ack_')) ||
    (method === 'orchestration.federationImport' && requestId.startsWith('relay_import_'))
  )
}
