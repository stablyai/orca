import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'
import { listDefaultIdentityFilePaths, resolveIdentityFilePaths } from './ssh-auth-resolution'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'
import {
  MAX_SSH_IDENTITY_FILE_BYTES,
  isOpenSshSecurityKeyPrivateKey,
  isOpenSshSecurityKeyPublicKey
} from './ssh-security-key-identity'
import { isOpenSshConfigBackedTarget } from './system-ssh-args'
import { findSystemSsh } from './system-ssh-binary'

type TransportResolvedConfig = Pick<
  SshResolvedConfig,
  'proxyUseFdpass' | 'proxyCommand' | 'proxyJump'
>

const READ_CHUNK_BYTES = 64 * 1024
const READ_OPEN_FLAGS =
  constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)

type IdentityInspection = { privateIdentityExists: boolean; requiresSystemSsh: boolean }

async function readBoundedKeyFile(path: string): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const pathStats = await stat(path)
    if (!pathStats.isFile() || pathStats.size > MAX_SSH_IDENTITY_FILE_BYTES) {
      return null
    }
    handle = await open(path, READ_OPEN_FLAGS)
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > MAX_SSH_IDENTITY_FILE_BYTES) {
      return null
    }
    const chunks: Buffer[] = []
    let offset = 0
    while (offset <= MAX_SSH_IDENTITY_FILE_BYTES) {
      const buffer = Buffer.alloc(
        Math.min(READ_CHUNK_BYTES, MAX_SSH_IDENTITY_FILE_BYTES + 1 - offset)
      )
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) {
        break
      }
      offset += bytesRead
      if (offset > MAX_SSH_IDENTITY_FILE_BYTES) {
        return null
      }
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, offset)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function inspectIdentityPath(keyPath: string): Promise<IdentityInspection> {
  const resolvedPath = resolveSshConfigHomePath(keyPath)
  const identity = await readBoundedKeyFile(resolvedPath)
  if (identity !== null) {
    return {
      privateIdentityExists: true,
      requiresSystemSsh:
        isOpenSshSecurityKeyPublicKey(identity) || isOpenSshSecurityKeyPrivateKey(identity)
    }
  }
  const publicIdentity = await readBoundedKeyFile(`${resolvedPath}.pub`)
  return {
    privateIdentityExists: false,
    requiresSystemSsh: publicIdentity !== null && isOpenSshSecurityKeyPublicKey(publicIdentity)
  }
}

export function shouldUseSystemSshTransport(
  target: SshTarget,
  resolved: TransportResolvedConfig | null
): boolean {
  if (isOpenSshConfigBackedTarget(target) && resolved) {
    return (
      process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT === '1' ||
      resolved.proxyUseFdpass === true ||
      resolved.proxyCommand != null ||
      resolved.proxyJump != null
    )
  }
  return (
    process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT === '1' ||
    target.proxyCommand != null ||
    target.jumpHost != null ||
    resolved?.proxyUseFdpass === true ||
    resolved?.proxyCommand != null ||
    resolved?.proxyJump != null
  )
}

export async function requiresSystemSshForSecurityKey(
  target: SshTarget,
  resolved: Pick<SshResolvedConfig, 'identityFile'> | null
): Promise<boolean> {
  const configuredPaths = resolveIdentityFilePaths(target, resolved)
  const usesDefaultPaths = configuredPaths.length === 0 && !resolved && !target.identityFile
  const identityPaths = usesDefaultPaths ? listDefaultIdentityFilePaths() : configuredPaths
  for (const keyPath of identityPaths) {
    const inspection = await inspectIdentityPath(keyPath)
    if (inspection.requiresSystemSsh) {
      return !usesDefaultPaths || findSystemSsh() !== null
    }
    if (usesDefaultPaths && inspection.privateIdentityExists) {
      return false
    }
  }
  return false
}
