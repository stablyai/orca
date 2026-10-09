import { randomBytes } from 'node:crypto'
import { runWslProcess } from '../wsl/wsl-runner'
import {
  type AntigravityCredentialBackend,
  remainingAccountOperationMs,
  withAntigravityAccountOperation,
  type AntigravityAccountOperation
} from './native-account-service'
import type { ResolvedAntigravityWslTarget } from './native-wsl-account-target'
import { parseAntigravityNativeCredential } from './native-credential-codec'
import {
  buildAntigravityWslCredentialCommand,
  decodeAntigravityWslReply,
  MAX_WSL_CREDENTIAL_TRANSPORT_BYTES
} from './native-wsl-credential-script'

export function createAntigravityWslCredentialBackend(
  authority: ResolvedAntigravityWslTarget
): AntigravityCredentialBackend {
  async function runRead(operation: AntigravityAccountOperation) {
    const nonce = randomBytes(16).toString('hex')
    let result
    try {
      result = await runWslProcess({
        ...buildAntigravityWslCredentialCommand(
          'read',
          authority,
          nonce,
          Date.now() + remainingAccountOperationMs(operation)
        ),
        distro: authority.distro,
        loginPath: 'none',
        signal: operation.signal,
        timeoutMs: remainingAccountOperationMs(operation),
        maxOutputBytes: MAX_WSL_CREDENTIAL_TRANSPORT_BYTES,
        killOnOutputLimit: true
      })
    } catch {
      throw new Error('Antigravity WSL credential could not be verified; refresh before retrying')
    }
    remainingAccountOperationMs(operation)
    if (result.code === 73) {
      throw new Error(
        'The native Antigravity credential changed while it was read; refresh before retrying.'
      )
    }
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error('Antigravity WSL credential could not be verified; refresh before retrying')
    }
    return decodeAntigravityWslReply(result.stdout, nonce)
  }
  return {
    read(operation) {
      const read = async (context: AntigravityAccountOperation) => {
        const reply = await runRead(context)
        if (reply.status === 'missing') {
          return null
        }
        return parseAntigravityNativeCredential(reply.contents)
      }
      return operation ? read(operation) : withAntigravityAccountOperation(read)
    },
    async write() {
      // The native CLI does not share Orca's lock or expose a transactional credential writer.
      throw new Error(
        `Orca cannot safely switch Antigravity credentials in WSL. Sign in with agy on "${authority.distro}", then refresh Accounts and save the current account.`
      )
    }
  }
}
