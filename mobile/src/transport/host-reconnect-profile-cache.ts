import type { HostProfile } from './types'
import { hostProfileAfterEdit, type HostProfileEdit } from './host-endpoint-edit'

type CachedHostProfile = {
  host: HostProfile
  version: number
  publicationVersion: number
  sourceRevision: number
}

export type HostOpenProfile = {
  host: HostProfile | undefined
  sourceRevision: number
  version: number
}

export class HostReconnectProfileCache {
  private readonly profiles = new Map<string, CachedHostProfile>()
  private readonly latestVersions = new Map<string, number>()
  private readonly publicationVersions = new Map<string, number>()

  prime(host: HostProfile, sourceRevision: number): number {
    const previous = this.profiles.get(host.id)
    const current = this.freshProfile(host.id, sourceRevision)
    const version =
      current && reconnectProfileMatches(current.host, host)
        ? current.version
        : (this.latestVersions.get(host.id) ?? 0) + 1
    this.latestVersions.set(host.id, version)
    const publicationVersion =
      previous && reconnectProfileMatches(previous.host, host)
        ? previous.publicationVersion
        : (this.publicationVersions.get(host.id) ?? 0) + 1
    this.publicationVersions.set(host.id, publicationVersion)
    this.profiles.set(host.id, {
      host,
      version,
      publicationVersion,
      sourceRevision
    })
    return version
  }

  reconnectProfile(
    hostId: string,
    currentRevision: number,
    requestedHost?: HostProfile
  ): HostOpenProfile {
    return requestedHost
      ? {
          host: requestedHost,
          sourceRevision: currentRevision,
          version: this.prime(requestedHost, currentRevision)
        }
      : {
          host: this.get(hostId, currentRevision),
          sourceRevision: currentRevision,
          version: this.version(hostId, currentRevision)
        }
  }

  reconnectEditedProfile(
    hostId: string,
    currentRevision: number,
    fallbackHost: HostProfile,
    updates: HostProfileEdit
  ): HostOpenProfile {
    const cached = this.profiles.get(hostId)?.host
    const base = cached && reconnectIdentityMatches(cached, fallbackHost) ? cached : fallbackHost
    const host = hostProfileAfterEdit(base, updates)
    return {
      host,
      sourceRevision: currentRevision,
      version: this.prime(host, currentRevision)
    }
  }

  openProfile(
    hostId: string,
    currentRevision: number,
    requested?: HostOpenProfile
  ): HostOpenProfile {
    return requested?.host
      ? requested
      : {
          host: this.get(hostId, currentRevision),
          sourceRevision: currentRevision,
          version: this.version(hostId, currentRevision)
        }
  }

  primeLoaded(host: HostProfile, sourceRevision: number, currentRevision: number): number | null {
    if (sourceRevision !== currentRevision) {
      return null
    }
    return this.prime(host, sourceRevision)
  }

  primeLoadedHosts(hosts: HostProfile[], sourceRevision: number, currentRevision: number): void {
    for (const host of hosts) {
      this.primeLoaded(host, sourceRevision, currentRevision)
    }
  }

  primeFromVersion(
    host: HostProfile,
    sourcePublicationVersion: number,
    sourceRevision: number
  ): number | null {
    if ((this.publicationVersions.get(host.id) ?? 0) !== sourcePublicationVersion) {
      return null
    }
    const version = (this.latestVersions.get(host.id) ?? 0) + 1
    const publicationVersion = sourcePublicationVersion + 1
    this.latestVersions.set(host.id, version)
    this.publicationVersions.set(host.id, publicationVersion)
    this.profiles.set(host.id, {
      host,
      version,
      publicationVersion,
      sourceRevision
    })
    return version
  }

  publisher(
    hostId: string,
    initialVersion: number,
    getCurrentRevision: () => number
  ): (host: HostProfile, sourceRevision?: number) => void {
    const initial = this.profiles.get(hostId)
    let sourcePublicationVersion =
      initial?.version === initialVersion
        ? initial.publicationVersion
        : (this.publicationVersions.get(hostId) ?? 0)
    return (host, publishedSourceRevision) => {
      const currentRevision = getCurrentRevision()
      const sourceRevision = publishedSourceRevision ?? currentRevision
      if (host.id !== hostId || sourceRevision !== currentRevision) {
        return
      }
      const nextVersion = this.primeFromVersion(host, sourcePublicationVersion, sourceRevision)
      if (nextVersion !== null) {
        sourcePublicationVersion = this.publicationVersions.get(hostId) ?? sourcePublicationVersion
      }
    }
  }

  get(hostId: string, currentRevision: number): HostProfile | undefined {
    return this.freshProfile(hostId, currentRevision)?.host
  }

  version(hostId: string, currentRevision: number): number {
    this.freshProfile(hostId, currentRevision)
    return this.latestVersions.get(hostId) ?? 0
  }

  delete(hostId: string): void {
    this.profiles.delete(hostId)
    this.publicationVersions.set(hostId, (this.publicationVersions.get(hostId) ?? 0) + 1)
  }

  private freshProfile(hostId: string, currentRevision: number): CachedHostProfile | undefined {
    const profile = this.profiles.get(hostId)
    if (!profile || profile.sourceRevision === currentRevision) {
      return profile
    }
    this.profiles.delete(hostId)
    this.latestVersions.set(hostId, (this.latestVersions.get(hostId) ?? 0) + 1)
    return undefined
  }
}

function reconnectProfileMatches(left: HostProfile, right: HostProfile): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.deviceToken === right.deviceToken &&
    left.publicKeyB64 === right.publicKeyB64 &&
    left.relayHostId === right.relayHostId &&
    JSON.stringify(left.endpoints ?? null) === JSON.stringify(right.endpoints ?? null) &&
    JSON.stringify(left.relay ?? null) === JSON.stringify(right.relay ?? null)
  )
}

function reconnectIdentityMatches(left: HostProfile, right: HostProfile): boolean {
  return (
    left.id === right.id &&
    left.deviceToken === right.deviceToken &&
    left.publicKeyB64 === right.publicKeyB64
  )
}
