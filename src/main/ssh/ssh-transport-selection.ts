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

async function identityRequiresSystemSsh(keyPath: string): Promise<boolean> {
  const resolvedPath = resolveSshConfigHomePath(keyPath)
  const identity = await readBoundedKeyFile(resolvedPath)
  // Why: a present private key wins; a `.pub` beside it may describe a key already replaced.
  if (identity !== null) {
    return isOpenSshSecurityKeyPublicKey(identity) || isOpenSshSecurityKeyPrivateKey(identity)
  }
  const publicIdentity = await readBoundedKeyFile(`${resolvedPath}.pub`)
  return publicIdentity !== null && isOpenSshSecurityKeyPublicKey(publicIdentity)
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
  const resolvedPaths = resolveIdentityFilePaths(target, resolved)
  // Why: `ssh -G` already echoes OpenSSH's built-in defaults, so its list is the real candidate
  // set; guess at the defaults only when config resolution failed outright.
  const identityPaths =
    resolvedPaths.length === 0 && !resolved && !target.identityFile
      ? listDefaultIdentityFilePaths()
      : resolvedPaths
  for (const keyPath of identityPaths) {
    if (await identityRequiresSystemSsh(keyPath)) {
      // Why: scan every candidate — an earlier normal key never rules out a security key the host
      // requires — but forcing system transport with no binary hard-fails a connection ssh2 could
      // still have served over agent or password auth.
      return findSystemSsh() !== null
    }
  }
  return false
}
