import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'

export const SSH_KEY_FILE_MAX_BYTES = 1024 * 1024

export function readSshKeyFile(filePath: string): Buffer {
  return readNodeFileSyncWithinLimit(filePath, SSH_KEY_FILE_MAX_BYTES).buffer
}
