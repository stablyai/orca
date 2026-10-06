import { randomBytes } from 'node:crypto'
import { runWslProcess } from '../wsl/wsl-runner'
import type { AntigravityCredentialBackend } from './native-account-service'
import {
  remainingAccountOperationMs,
  withAntigravityAccountOperation,
  type AntigravityAccountOperation
} from './native-account-operation'
import {
  resolveAntigravityWslTarget,
  type ResolvedAntigravityWslTarget
} from './native-wsl-account-target'
import { parseAntigravityNativeCredential } from './native-credential-codec'
import { buildAntigravityWslCredentialCommand } from './native-wsl-credential-script'
import {
  decodeAntigravityWslReply,
  encodeAntigravityWslWrite,
  MAX_WSL_CREDENTIAL_TRANSPORT_BYTES
} from './native-wsl-credential-protocol'

export function createAntigravityWslCredentialBackend(
  authority: ResolvedAntigravityWslTarget
): AntigravityCredentialBackend {
  async function run(
    action: 'read' | 'write',
    operation: AntigravityAccountOperation,
    input?: string
  ) {
    const current = await resolveAntigravityWslTarget(
      { runtime: 'wsl', wslDistro: authority.distro },
      operation
    )
    if (current.authorityId !== authority.authorityId) {
      throw new Error('Antigravity WSL credential authority changed; reload Accounts')
    }
    const nonce = randomBytes(16).toString('hex')
    let result
    try {
      result = await runWslProcess({
        ...buildAntigravityWslCredentialCommand(action, authority, nonce, operation.deadline),
        distro: authority.distro,
        loginPath: 'none',
        input,
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
        'The native Antigravity credential changed during selection; refresh before retrying.'
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
        const reply = await run('read', context)
        if (reply.status === 'missing') {
          return null
        }
        if (reply.status !== 'present') {
          throw new Error('Invalid WSL credential protocol')
        }
        return parseAntigravityNativeCredential(reply.contents)
      }
      return operation ? read(operation) : withAntigravityAccountOperation(read)
    },
    write(contents, expected, operation) {
      const write = async (context: AntigravityAccountOperation) => {
        parseAntigravityNativeCredential(contents)
        if (expected !== null) {
          parseAntigravityNativeCredential(expected)
        }
        const reply = await run('write', context, encodeAntigravityWslWrite(contents, expected))
        if (reply.status !== 'written' || reply.contents !== contents) {
          throw new Error(
            'Antigravity WSL credential switching could not be verified; refresh before retrying'
          )
        }
      }
      return operation ? write(operation) : withAntigravityAccountOperation(write)
    }
  }
}
