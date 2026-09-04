// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithResolveTerminalPath } from './runtime-file-commands-resolve-terminal-path'
import {
  assertLocalTerminalArtifactPathStillCanonical,
  resolveAllowedLocalTerminalArtifactPath
} from './runtime-file-commands-terminal-file-paths'
import {
  assertTerminalArtifactNotHardLinked,
  canonicalPathForArtifactComparison,
  isTerminalArtifactHardLinked,
  terminalFileStatIdentity
} from './runtime-file-commands-terminal-artifact-access'
import {
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE,
  getSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { open } from 'node:fs/promises'
import type {
  RuntimeFileStatLike,
  TerminalFileGrant
} from './runtime-file-commands-mobile-file-list-limit'
import { TERMINAL_FILE_GRANT_TTL_MS } from './runtime-file-commands-mobile-file-list-limit'
import type { RuntimeTerminalPathResolution } from '../../shared/runtime-types'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { randomUUID } from 'node:crypto'
import {
  runtimeFileSshTargetId,
  type ResolvedRuntimeFileTarget
} from './runtime-file-command-target'

export class RuntimeFileCommandsWithResolveAllowedTerminalArtifactPath extends RuntimeFileCommandsWithResolveTerminalPath {
  protected async resolveAllowedTerminalArtifactPath(args: {
    absolutePath: string
    connectionId?: string
    worktreePath: string
  }): Promise<string | null> {
    if (args.connectionId) {
      return this.resolveAllowedRemoteTerminalArtifactPath(args.absolutePath, args.connectionId)
    }
    return resolveAllowedLocalTerminalArtifactPath(args.absolutePath, args.worktreePath)
  }

  protected async resolveNativeChatArtifactPath(
    absolutePath: string,
    connectionId?: string
  ): Promise<string> {
    if (!connectionId) {
      return canonicalPathForArtifactComparison(absolutePath)
    }
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    return provider.realpath(absolutePath)
  }

  protected async resolveAbsoluteFileGrant(args: {
    worktreeId: string
    artifactPath: string
    rejectedAbsolutePath?: string
    connectionId?: string
    clientId?: string
    readOnly?: boolean
    provenance?: TerminalFileGrant['provenance']
  }): Promise<RuntimeTerminalPathResolution> {
    const stats = args.connectionId
      ? await this.statRemoteTerminalPath(args.artifactPath, args.connectionId)
      : await this.statLocalTerminalPath(args.artifactPath)
    const isDirectory = stats.isDirectory()
    if (!isDirectory && isTerminalArtifactHardLinked(stats)) {
      return {
        worktree: args.worktreeId,
        relativePath: null,
        absolutePath: args.rejectedAbsolutePath ?? args.artifactPath,
        exists: false,
        isDirectory: false
      }
    }
    const grant = isDirectory
      ? null
      : this.createTerminalFileGrant({
          worktreeId: args.worktreeId,
          absolutePath: args.artifactPath,
          provider: args.connectionId ? 'ssh' : 'local',
          connectionId: args.connectionId,
          clientId: args.clientId,
          readOnly: args.readOnly === true,
          provenance: args.provenance ?? 'terminal-output',
          stats
        })
    return {
      worktree: args.worktreeId,
      relativePath: null,
      absolutePath: args.artifactPath,
      exists: true,
      isDirectory,
      openTarget: grant
        ? {
            kind: 'absolute-file',
            provider: grant.provider,
            absolutePath: args.artifactPath,
            grantId: grant.id,
            ...(grant.readOnly ? { readOnly: true } : {})
          }
        : undefined
    }
  }

  protected async resolveAllowedRemoteTerminalArtifactPath(
    absolutePath: string,
    connectionId: string
  ): Promise<string | null> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const roots = ['/tmp', '/private/tmp']
    const providerTempDir = await provider.getTempDir?.().catch(() => null)
    if (providerTempDir) {
      roots.push(providerTempDir)
    }
    if (!roots.some((root) => isPathInsideOrEqual(root, absolutePath))) {
      return null
    }
    const [realArtifactPath, ...realRoots] = await Promise.all([
      provider.realpath(absolutePath),
      ...roots.map((root) => provider.realpath(root).catch(() => root))
    ])
    // Why: SSH I/O follows symlinks on the relay; grant the canonical target so a /tmp link can't escape the temp boundary.
    return realRoots.some((root) => isPathInsideOrEqual(root, realArtifactPath))
      ? realArtifactPath
      : null
  }

  protected async statLocalTerminalPath(
    absolutePath: string
  ): Promise<RuntimeFileStatLike & { isDirectory: () => boolean }> {
    await assertLocalTerminalArtifactPathStillCanonical(absolutePath)
    const handle = await open(absolutePath, 'r')
    try {
      return handle.stat()
    } finally {
      await handle.close()
    }
  }

  protected createTerminalFileGrant(args: {
    worktreeId: string
    absolutePath: string
    provider: 'local' | 'ssh'
    connectionId?: string
    clientId?: string
    readOnly?: boolean
    provenance: TerminalFileGrant['provenance']
    stats: RuntimeFileStatLike
  }): TerminalFileGrant {
    assertTerminalArtifactNotHardLinked(args.stats)
    const grant: TerminalFileGrant = {
      id: randomUUID(),
      worktreeId: args.worktreeId,
      absolutePath: args.absolutePath,
      provider: args.provider,
      ...(args.connectionId ? { connectionId: args.connectionId } : {}),
      ...(args.clientId ? { clientId: args.clientId } : {}),
      expiresAt: Date.now() + TERMINAL_FILE_GRANT_TTL_MS,
      statIdentity: terminalFileStatIdentity(args.stats),
      readOnly: args.readOnly === true,
      provenance: args.provenance
    }
    this.terminalFileGrants.set(grant.id, grant)
    this.scheduleTerminalFileGrantExpiry(grant)
    return grant
  }

  protected async requireTerminalFileGrant(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string
  ): Promise<{ grant: TerminalFileGrant; target: ResolvedRuntimeFileTarget }> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    this.pruneExpiredTerminalFileGrants()
    const grant = this.terminalFileGrants.get(grantId)
    if (!grant) {
      throw new Error('terminal_file_grant_expired')
    }
    if (grant.expiresAt <= Date.now()) {
      this.releaseTerminalFileGrant(grantId, grant)
      throw new Error('terminal_file_grant_expired')
    }
    if (
      grant.worktreeId !== target.worktree.id ||
      grant.absolutePath !== absolutePath ||
      grant.connectionId !== runtimeFileSshTargetId(target) ||
      grant.clientId !== clientId
    ) {
      throw new Error('terminal_file_grant_mismatch')
    }
    return { grant, target }
  }

  protected refreshTerminalFileGrant(grant: TerminalFileGrant): void {
    grant.expiresAt = Date.now() + TERMINAL_FILE_GRANT_TTL_MS
    this.scheduleTerminalFileGrantExpiry(grant)
  }

  protected pruneExpiredTerminalFileGrants(): void {
    const now = Date.now()
    for (const [id, grant] of this.terminalFileGrants) {
      if (grant.expiresAt <= now) {
        this.releaseTerminalFileGrant(id, grant)
      }
    }
  }
}
