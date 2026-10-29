import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { AgentSessionAssociationObservation } from '../../shared/agent-session-status-snapshot-fold'
import { getRuntimeEnvironmentTransportGeneration } from './runtime-environments/runtime-environment-transport-generation'

type Authority = { identity: string; revision: number; references: number }
const authorities = new Map<string, Authority>()
let sequence = 0
export type AiVaultProjectionDependency = {
  key: string
  hosts: readonly string[]
  isCurrent: () => boolean
  retain: () => () => void
  release: () => void
  forHost: (host: string) => AiVaultProjectionDependency
}

/** Only subscriptions, pending requests and retained projected answers hold authority tokens. */
export function captureAiVaultProjectionDependency(
  hosts: readonly string[],
  identity: (host: string) => string
): AiVaultProjectionDependency {
  const qualified = hosts.map((host) => ({ host, hostIdentity: identity(host) }))
  const held = qualified.map(({ host, hostIdentity }) => {
    let authority = authorities.get(host)
    if (!authority || authority.identity !== hostIdentity) {
      authority = { identity: hostIdentity, revision: ++sequence, references: 0 }
      authorities.set(host, authority)
    }
    return {
      host,
      authority,
      revision: authority.revision,
      transport: getRuntimeEnvironmentTransportGeneration(host)
    }
  })
  const select = (selected: typeof held, owned: boolean): AiVaultProjectionDependency => {
    const retain = () => {
      selected.forEach(({ authority }) => authority.references++)
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        for (const { host, authority } of selected) {
          if (--authority.references === 0 && authorities.get(host) === authority) {
            authorities.delete(host)
          }
        }
      }
    }
    return {
      hosts: selected.map(({ host }) => host),
      key: JSON.stringify(
        selected.map(({ host, authority, revision, transport }) => [
          host,
          authority.identity,
          revision,
          transport
        ])
      ),
      isCurrent: () =>
        selected.every(
          ({ host, authority, revision, transport }) =>
            authorities.get(host) === authority &&
            authority.revision === revision &&
            getRuntimeEnvironmentTransportGeneration(host) === transport
        ),
      retain,
      release: owned ? retain() : () => {},
      forHost: (host) =>
        select(
          selected.filter((entry) => entry.host === host),
          false
        )
    }
  }
  return select(held, true)
}

export function createAiVaultAssociationObserver(
  environmentId: string,
  identity: string,
  invalidate: (environmentId: string) => void
) {
  const dependency = captureAiVaultProjectionDependency([environmentId], () => identity)
  const authority = authorities.get(environmentId)!
  const observation = new AgentSessionAssociationObservation()
  return {
    observe: (frame: unknown) => {
      if (authorities.get(environmentId) === authority && observation.observe(frame)) {
        authority.revision = ++sequence
        invalidate(environmentId)
      }
    },
    dispose: dependency.release
  }
}

export function captureRuntimeAiVaultProjectionDependency(
  hosts: readonly string[],
  getUserDataPath?: () => string
): AiVaultProjectionDependency {
  return captureAiVaultProjectionDependency(hosts, (environmentId) => {
    const path = getUserDataPath?.()
    const environment = path ? resolveEnvironment(path, environmentId) : undefined
    return JSON.stringify([
      environment?.runtimeId,
      environment?.pairingRevision ?? environment?.createdAt
    ])
  })
}
