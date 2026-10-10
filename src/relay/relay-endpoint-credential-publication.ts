/**
 * The relay daemon owns its endpoint credential.
 *
 * The client used to mint the credential before launching a daemon. A launch that then lost the
 * socket bind to a still-running relay had already rotated the file, so every later --connect
 * authenticated against a secret the surviving daemon never held, and that daemon sat forever
 * refusing clients while holding its PTYs. Only a process whose listen() succeeded can prove it
 * owns the endpoint, and that proof is atomic with the bind — so publication happens here, after
 * the bind, in the daemon. A losing starter exits before reaching this file and touches nothing.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { runProcess } from '../shared/child-process/run-process'
import { relayLogLine } from './relay-diagnostic-log'

const ENDPOINT_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{32,256}$/

export function isValidRelayEndpointCredential(value: string): boolean {
  return ENDPOINT_CREDENTIAL_PATTERN.test(value)
}

export function mintRelayEndpointCredential(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * A file this daemon may trust as its credential: owner-only mode and owned by this uid on
 * POSIX. Anyone who can produce such a file inside our relay dir already runs as us. Windows
 * relies on the profile dir's inherited ACL plus the icacls tightening below.
 */
function readOwnerOnlyRelayEndpointCredential(credentialFile: string): string | undefined {
  try {
    if (process.platform !== 'win32') {
      const stat = statSync(credentialFile)
      if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
        return undefined
      }
    }
    const value = readFileSync(credentialFile, 'utf8').trim()
    return isValidRelayEndpointCredential(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Read a credential the file already holds, or undefined when there is none to adopt.
 *
 * Why adopt rather than always mint: clients older than this daemon still pre-write the file
 * before launching, and their --connect reads it back. Overwriting it would lock them out.
 * A file that fails the owner-only rule is not adopted; it is replaced by a fresh mint.
 */
export function readAdoptableRelayEndpointCredential(credentialFile: string): string | undefined {
  return readOwnerOnlyRelayEndpointCredential(credentialFile)
}

/** Atomic, owner-only publication: temp file created exclusively, then renamed over the path. */
export function writeRelayEndpointCredentialFile(credentialFile: string, credential: string): void {
  const tempFile = `${credentialFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(tempFile, credential, { flag: 'wx', mode: 0o600 })
    renameSync(tempFile, credentialFile)
  } catch (error) {
    try {
      unlinkSync(tempFile)
    } catch {
      /* the temp file was never created, or the rename already consumed it */
    }
    throw error
  }
  if (process.platform !== 'win32') {
    chmodSync(credentialFile, 0o600)
  }
}

/**
 * Establish the credential this daemon will enforce. Call only after the socket bind succeeded.
 * Returns the credential, or undefined when the launch requested none.
 */
export function publishRelayEndpointCredential(
  credentialFile: string | undefined
): string | undefined {
  if (!credentialFile) {
    return undefined
  }
  const adopted = readAdoptableRelayEndpointCredential(credentialFile)
  if (adopted !== undefined) {
    return adopted
  }
  const minted = mintRelayEndpointCredential()
  writeRelayEndpointCredentialFile(credentialFile, minted)
  relayLogLine(`[relay] Endpoint credential published: ${credentialFile}`)
  return minted
}

// Why best-effort and after publication: the file's inherited ACL is already user-scoped under
// the profile dir; this tightens it to match the POSIX 0600 contract without gating readiness.
export async function restrictWindowsRelayEndpointCredential(
  credentialFile: string
): Promise<void> {
  if (process.platform !== 'win32' || !process.env.USERNAME) {
    return
  }
  try {
    await runProcess({
      program: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\icacls.exe`,
      args: [credentialFile, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R,W)`],
      timeoutMs: 10_000
    })
  } catch (error) {
    relayLogLine(
      `[relay] Could not restrict endpoint credential ACL: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
