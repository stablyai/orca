import {
  SessionSearchContainerSources,
  type SessionSearchContainerFamily,
  type SessionSearchContainerPhysical
} from './session-search-container-sources'
import type { SessionSearchContainerRemoval } from './session-search-container-transition'
import { SessionSearchOperationError } from './session-search-worker-client'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'

type Owner = {
  key: string
  path: string
  family: SessionSearchContainerFamily
  physical: SessionSearchContainerPhysical
}

/** Omission pages cross the candidate barrier only after every family has supplied its positives. */
export class SessionSearchContainerRetirements extends SessionSearchContainerSources {
  private retirementOwners: Generator<Owner> | undefined
  protected clearRetirements(): void {
    this.retirementOwners = undefined
  }
  private *owners(): Generator<Owner> {
    for (const [key, family] of this.families) {
      for (const [path, physical] of family.physical) {
        yield { key, path, family, physical }
      }
    }
  }
  async continueRetirements(
    accept: (
      agents: ReadonlyMap<string, ReadonlySet<string>>,
      receipts: ReadonlyMap<string, SessionSearchContainerRemoval[]>
    ) => Promise<void>,
    overdue: () => boolean,
    signal?: AbortSignal
  ): Promise<void> {
    const blocked = new Set<SessionSearchContainerPhysical>()
    let progressed = this.retirementOwners !== undefined
    for (;;) {
      throwIfAiVaultScanCancelled(signal)
      this.retirementOwners ??= this.owners()
      const next = this.retirementOwners.next()
      if (next.done) {
        this.retirementOwners = undefined
        if (!progressed) {
          return
        }
        progressed = false
        continue
      }
      const { key, path, family, physical } = next.value
      if (
        family.physical.get(path) !== physical ||
        blocked.has(physical) ||
        !physical.authority ||
        physical.authority.state === 'unknown'
      ) {
        continue
      }
      if (physical.retirement) {
        await this.advanceRetirement(key, family, physical)
        progressed = true
      } else if (physical.omissions.readySize) {
        const before = physical.omissions.size
        const page = await physical.omissions.page({ ready: 1, limit: 256 })
        const agents = new Map<string, Set<string>>()
        const receipts = new Map<string, SessionSearchContainerRemoval[]>()
        for (const { key: omitted, value } of page.rows) {
          if (
            value.authority === physical.authority.revision &&
            value.incarnation === physical.authority.incarnation
          ) {
            agents.set(omitted, new Set([value.agent]))
            receipts.set(omitted, [{ ...value, scope: physical.files.scope }])
          }
        }
        if (receipts.size) {
          await accept(agents, receipts)
          await this.request!({ kind: 'count', scope: physical.omissions.scope })
        }
        if (physical.omissions.size < before) {
          progressed = true
        } else {
          blocked.add(physical)
        }
      } else if (physical.retiring && !physical.files.size) {
        await this.release(key, path, family, physical)
        progressed = true
      } else {
        continue
      }
      if (overdue()) {
        return
      }
    }
  }
  protected async release(
    key: string,
    path: string,
    family: SessionSearchContainerFamily,
    physical: SessionSearchContainerPhysical
  ): Promise<void> {
    if (!physical.retiring || physical.authority?.state !== 'released') {
      await this.setAuthority(key, path, physical, 'released')
      physical.retiring = true
      physical.retirement = { authority: physical.authority!.revision, phase: 'raw' }
    }
    physical.fullDue = false
    this.retries.delete(`${key}:${path}`)
    this.acceptedProofs.delete(`${key.split(':', 1)[0]}:${path}`)
    if (!physical.retirement && !physical.omissions.size && !physical.files.size) {
      await physical.files.transition({
        kind: 'release',
        scope: `${physical.files.scope}:authority`
      })
      family.physical.delete(path)
    }
  }
  protected async advanceRetirement(
    key: string,
    family: SessionSearchContainerFamily,
    physical: SessionSearchContainerPhysical
  ): Promise<void> {
    const retirement = physical.retirement
    if (
      !retirement ||
      physical.authority?.state === 'unknown' ||
      physical.authority?.revision !== retirement.authority
    ) {
      return
    }
    const result = await physical.files.transition({
      kind: 'container-retire',
      scope: physical.files.scope,
      authorityRevision: retirement.authority,
      phase: retirement.phase,
      after: retirement.after,
      agent: family.discovery?.agent ?? key.split(':', 1)[0]
    })
    if (!result.accepted) {
      throw new SessionSearchOperationError('Container cleanup was superseded')
    }
    retirement.after = result.after
    if (!result.after) {
      if (retirement.phase === 'raw') {
        retirement.phase = 'receipts'
      } else {
        physical.retirement = undefined
      }
    }
  }
}
