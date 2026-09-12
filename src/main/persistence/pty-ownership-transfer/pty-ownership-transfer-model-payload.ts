import { parsePtyOwnershipModelRestoreMetadata } from './pty-ownership-transfer-model-restore-metadata'

export function parsePtyOwnershipModelPayload(
  value: unknown,
  options: { allowEmpty?: boolean } = {}
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_output_model_snapshot_invalid')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.modelData !== 'string' ||
    (!record.modelData && !options.allowEmpty) ||
    Buffer.byteLength(record.modelData, 'utf8') > 4 * 1024 * 1024 ||
    ![record.cols, record.rows].every(
      (v) => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 10000
    )
  ) {
    throw new Error('pty_ownership_transfer_output_model_snapshot_invalid')
  }
  return {
    modelData: record.modelData,
    cols: Number(record.cols),
    rows: Number(record.rows),
    ...(record.restoreMetadata !== undefined
      ? { restoreMetadata: parsePtyOwnershipModelRestoreMetadata(record.restoreMetadata) }
      : {})
  }
}
