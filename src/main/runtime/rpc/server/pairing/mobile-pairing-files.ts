import { E2EE_KEYPAIR_FILENAME } from '../../../../../shared/remote-runtime/host-store/runtime-e2ee-keypair-file'

export const DEVICE_REGISTRY_FILENAME = 'orca-devices.json'

// Migrate these together so device tokens and E2EE material never split across dirs.
export const MOBILE_PAIRING_USERDATA_FILES = [
  DEVICE_REGISTRY_FILENAME,
  E2EE_KEYPAIR_FILENAME
] as const
