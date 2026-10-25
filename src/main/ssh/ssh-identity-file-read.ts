import {
  NodeFileNotRegularError,
  NodeFileReadTooLargeError,
  readNodeFileSyncWithinLimit,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import { MAX_SSH_IDENTITY_FILE_BYTES } from './ssh-security-key-identity'

/** `problem` is null when the file is simply absent, which is normal for default key paths. */
export type SshIdentityFileRead = { contents: Buffer } | { contents: null; problem: string | null }

const READ_OPTIONS = { regularFileOnly: true }

// Config paths may name FIFOs/devices/huge files; require bounded regular-file reads so main cannot block.
export function readSshIdentityFileSync(filePath: string): SshIdentityFileRead {
  try {
    return {
      contents: readNodeFileSyncWithinLimit(filePath, MAX_SSH_IDENTITY_FILE_BYTES, READ_OPTIONS)
        .buffer
    }
  } catch (error) {
    return { contents: null, problem: describeIdentityFileProblem(error) }
  }
}

export async function readSshIdentityFile(filePath: string): Promise<SshIdentityFileRead> {
  try {
    const read = await readNodeFileWithinLimit(filePath, MAX_SSH_IDENTITY_FILE_BYTES, READ_OPTIONS)
    return { contents: read.buffer }
  } catch (error) {
    return { contents: null, problem: describeIdentityFileProblem(error) }
  }
}

function describeIdentityFileProblem(error: unknown): string | null {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return null
  }
  if (error instanceof NodeFileReadTooLargeError) {
    return `it is larger than ${MAX_SSH_IDENTITY_FILE_BYTES / 1024 / 1024} MB`
  }
  if (error instanceof NodeFileNotRegularError) {
    return 'it is not a regular file'
  }
  return `it could not be read (${typeof code === 'string' ? code : String(error)})`
}
