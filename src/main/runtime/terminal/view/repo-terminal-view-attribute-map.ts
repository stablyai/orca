import type { PtyOwnerRepoColorsByHost } from '../../../../shared/terminal/pty/ingress/pty-owner-color-query-colors'
import {
  terminalViewColorQueryReplyColors,
  terminalViewAttributesEqual,
  type TerminalViewAttributes
} from '../../../../shared/terminal/protocol/queries/terminal-view-attributes'
import type { RepoTerminalViewAttributesByHost } from '../../../../shared/repo-terminal-view-attributes-by-host'

type RepoAttributesMap = ReadonlyMap<string, TerminalViewAttributes>
/** Execution host id → repo id → attributes; a host with no themed project is absent. */
export type RepoAttributesByHost = ReadonlyMap<string, RepoAttributesMap>

export function toRepoAttributesByHost(
  byHostId: RepoTerminalViewAttributesByHost
): RepoAttributesByHost {
  return new Map(
    Object.entries(byHostId)
      .map(([hostId, byRepoId]): [string, RepoAttributesMap] => [
        hostId,
        new Map(Object.entries(byRepoId))
      ])
      .filter(([, byRepoId]) => byRepoId.size > 0)
  )
}

function repoMapsEqual(current: RepoAttributesMap, next: RepoAttributesMap): boolean {
  if (current.size !== next.size) {
    return false
  }
  for (const [repoId, attributes] of next) {
    const existing = current.get(repoId)
    if (!existing || !terminalViewAttributesEqual(existing, attributes)) {
      return false
    }
  }
  return true
}

export function repoMapsByHostEqual(
  current: RepoAttributesByHost,
  next: RepoAttributesByHost
): boolean {
  if (current.size !== next.size) {
    return false
  }
  for (const [hostId, byRepoId] of next) {
    const existing = current.get(hostId)
    if (!existing || !repoMapsEqual(existing, byRepoId)) {
      return false
    }
  }
  return true
}

export function repoAttributesToViewerColors(
  byHost: RepoAttributesByHost
): PtyOwnerRepoColorsByHost {
  return Object.fromEntries(
    Array.from(byHost, ([hostId, byRepoId]) => [
      hostId,
      Object.fromEntries(
        Array.from(byRepoId, ([repoId, attributes]) => [
          repoId,
          terminalViewColorQueryReplyColors(attributes)
        ])
      )
    ])
  )
}
