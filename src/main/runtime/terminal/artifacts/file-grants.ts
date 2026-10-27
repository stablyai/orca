import { randomUUID } from 'node:crypto'
import { terminalFileStatIdentity } from './artifact-integrity'
import { runtimeFileSshTargetId, type ResolvedRuntimeFileTarget } from '../../files/file-target'

const TERMINAL_FILE_GRANT_TTL_MS = 10 * 60 * 1000

type TerminalFileGrantTarget = {
  worktree: Pick<ResolvedRuntimeFileTarget['worktree'], 'id'>
  executionHostId: ResolvedRuntimeFileTarget['executionHostId']
}

export type RuntimeTerminalFileGrantHost = {
  resolveRuntimeFileTarget(selector: string): Promise<TerminalFileGrantTarget>
}

export type RuntimeFileStatLike = {
  size?: number
  dev?: number
  ino?: number
  nlink?: number
  mtime?: number | Date
  mtimeMs?: number
  isDirectory?: () => boolean
}

export type TerminalFileGrant = {
  id: string
  worktreeId: string
  absolutePath: string
  provider: 'local'
  clientId?: string
  expiresAt: number
  statIdentity: string | null
  // Linux can reuse inodes and coarse mtimes; the digest catches same-size content swaps.
  contentDigest: string | null
  expiryTimer?: ReturnType<typeof setTimeout>
}

export class RuntimeTerminalFileGrants {
  private readonly terminalFileGrants = new Map<string, TerminalFileGrant>()

  constructor(private readonly host: RuntimeTerminalFileGrantHost) {}

  createTerminalFileGrant(args: {
    worktreeId: string
    absolutePath: string
    clientId?: string
    stats: RuntimeFileStatLike
    contentDigest?: string | null
  }): TerminalFileGrant {
    const grant: TerminalFileGrant = {
      id: randomUUID(),
      worktreeId: args.worktreeId,
      absolutePath: args.absolutePath,
      provider: 'local',
      ...(args.clientId ? { clientId: args.clientId } : {}),
      expiresAt: Date.now() + TERMINAL_FILE_GRANT_TTL_MS,
      statIdentity: terminalFileStatIdentity(args.stats),
      contentDigest: args.contentDigest ?? null
    }
    this.terminalFileGrants.set(grant.id, grant)
    this.scheduleTerminalFileGrantExpiry(grant)
    return grant
  }

  async requireTerminalFileGrant(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string
  ): Promise<{ grant: TerminalFileGrant; target: TerminalFileGrantTarget }> {
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
      // Grants are only minted for local paths; an SSH target never matches one.
      runtimeFileSshTargetId(target) !== undefined ||
      grant.clientId !== clientId
    ) {
      throw new Error('terminal_file_grant_mismatch')
    }
    return { grant, target }
  }

  refreshTerminalFileGrant(grant: TerminalFileGrant): void {
    grant.expiresAt = Date.now() + TERMINAL_FILE_GRANT_TTL_MS
    this.scheduleTerminalFileGrantExpiry(grant)
  }

  revokeTerminalFileGrantsForClient(clientId: string): void {
    for (const [id, grant] of this.terminalFileGrants) {
      if (grant.clientId === clientId) {
        this.releaseTerminalFileGrant(id, grant)
      }
    }
  }

  private pruneExpiredTerminalFileGrants(): void {
    const now = Date.now()
    for (const [id, grant] of this.terminalFileGrants) {
      if (grant.expiresAt <= now) {
        this.releaseTerminalFileGrant(id, grant)
      }
    }
  }

  private releaseTerminalFileGrant(id: string, grant: TerminalFileGrant): void {
    this.terminalFileGrants.delete(id)
    if (grant.expiryTimer) {
      clearTimeout(grant.expiryTimer)
      grant.expiryTimer = undefined
    }
  }

  private scheduleTerminalFileGrantExpiry(grant: TerminalFileGrant): void {
    if (grant.expiryTimer) {
      clearTimeout(grant.expiryTimer)
    }
    grant.expiryTimer = setTimeout(
      () => {
        if (this.terminalFileGrants.get(grant.id) === grant && grant.expiresAt <= Date.now()) {
          this.releaseTerminalFileGrant(grant.id, grant)
        }
      },
      Math.max(1, grant.expiresAt - Date.now())
    )
    grant.expiryTimer.unref?.()
  }
}
