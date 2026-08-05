import type { SshRemotePtyLease } from '../../shared/ssh-types'

export type SshRemotePtyLeaseSelection = {
  candidates: SshRemotePtyLease[]
  discardedDuplicates: SshRemotePtyLease[]
}

export type SshRemotePtyLeaseSelectionOptions = {
  isDurablyBound?: (lease: SshRemotePtyLease) => boolean
}

export function sshRemotePtyLeasePaneKey(lease: SshRemotePtyLease): string | null {
  if (!lease.worktreeId || !lease.tabId || !lease.leafId) {
    return null
  }
  return [lease.targetId, lease.worktreeId, lease.tabId, lease.leafId].join('\0')
}

function isNewerLease(candidate: SshRemotePtyLease, incumbent: SshRemotePtyLease): boolean {
  if (candidate.updatedAt !== incumbent.updatedAt) {
    return candidate.updatedAt > incumbent.updatedAt
  }
  if (candidate.createdAt !== incumbent.createdAt) {
    return candidate.createdAt > incumbent.createdAt
  }
  return candidate.ptyId > incumbent.ptyId
}

function newestLease(leases: readonly SshRemotePtyLease[]): SshRemotePtyLease {
  return leases.reduce((winner, lease) => (isNewerLease(lease, winner) ? lease : winner))
}

function isFinalLease(lease: SshRemotePtyLease): boolean {
  return lease.state === 'terminated' || lease.state === 'expired'
}

export function coalesceSshRemotePtyLeasesByIdentity(
  leases: readonly SshRemotePtyLease[]
): SshRemotePtyLease[] {
  const winnerByIdentity = new Map<string, SshRemotePtyLease>()
  for (const lease of leases) {
    const identity = `${lease.targetId}\0${lease.ptyId}`
    const incumbent = winnerByIdentity.get(identity)
    if (!incumbent || isNewerLease(lease, incumbent)) {
      winnerByIdentity.set(identity, lease)
    }
  }
  return leases.filter(
    (lease) => winnerByIdentity.get(`${lease.targetId}\0${lease.ptyId}`) === lease
  )
}

export function selectSshRemotePtyLeasesForReattach(
  leases: readonly SshRemotePtyLease[],
  options: SshRemotePtyLeaseSelectionOptions = {}
): SshRemotePtyLeaseSelection {
  const uniqueLeases = coalesceSshRemotePtyLeasesByIdentity(leases)
  const leasesByPaneKey = new Map<string, SshRemotePtyLease[]>()

  for (const lease of uniqueLeases) {
    const paneKey = sshRemotePtyLeasePaneKey(lease)
    if (!paneKey) {
      continue
    }
    const paneLeases = leasesByPaneKey.get(paneKey)
    if (paneLeases) {
      paneLeases.push(lease)
    } else {
      leasesByPaneKey.set(paneKey, [lease])
    }
  }

  const winnerByPaneKey = new Map<string, SshRemotePtyLease>()
  for (const [paneKey, paneLeases] of leasesByPaneKey) {
    const finalLeases = paneLeases.filter(isFinalLease)
    const newestFinal = finalLeases.length > 0 ? newestLease(finalLeases) : undefined
    const liveEpoch = newestFinal
      ? paneLeases.filter((lease) => isNewerLease(lease, newestFinal))
      : paneLeases
    if (liveEpoch.length === 0) {
      winnerByPaneKey.set(paneKey, newestFinal!)
      continue
    }
    if (liveEpoch.length === 1) {
      winnerByPaneKey.set(paneKey, liveEpoch[0])
      continue
    }
    const durablyBound = options.isDurablyBound ? liveEpoch.filter(options.isDurablyBound) : []
    winnerByPaneKey.set(paneKey, newestLease(durablyBound.length > 0 ? durablyBound : liveEpoch))
  }

  const candidates: SshRemotePtyLease[] = []
  const discardedDuplicates: SshRemotePtyLease[] = []
  for (const lease of uniqueLeases) {
    if (isFinalLease(lease)) {
      continue
    }
    const paneKey = sshRemotePtyLeasePaneKey(lease)
    if (!paneKey || winnerByPaneKey.get(paneKey) === lease) {
      candidates.push(lease)
    } else {
      discardedDuplicates.push(lease)
    }
  }
  return { candidates, discardedDuplicates }
}
