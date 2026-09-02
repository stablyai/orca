export const RELAY_UPLOAD_STAGE_POOL_NAME = '.upload-stages'
export const RELAY_UPLOAD_STAGE_SLOT_COUNT = 8
export const RELAY_UPLOAD_STAGE_STALE_SECONDS = 40 * 60

export const RELAY_UPLOAD_OWNER_FILE_NAME = '.orca-upload-owner'
export const RELAY_UPLOAD_IDENTITY_FILE_NAME = '.orca-upload-identity'
export const RELAY_UPLOAD_SLOT_RESULT_PREFIX = '__ORCA_UPLOAD_STAGE_SLOT__'
export const RELAY_UPLOAD_PROMOTION_RESULT_PREFIX = '__ORCA_UPLOAD_STAGE_PROMOTION__'

export type RelayUploadStageSlot = {
  claimDir: string
  deleteDir: string
  poolDir: string
  slotDir: string
  slotName: string
}
