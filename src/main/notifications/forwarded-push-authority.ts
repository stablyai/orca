import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  environmentStoreFromInputs,
  readEnvironmentStoreInputs
} from '../../shared/runtime-environment-store-file'
import type { EnvironmentStoreContentReader } from '../../shared/runtime-environment-store-records'
import { isWslHostsServing } from '../../shared/wsl-host-internal-gate'
import { deriveRelayHostId } from '../runtime/mobile-cloud-relay/relay-http-client'

export type ForwardedPushSource = {
  root: string
  environmentId: string
  method: string
  binding: string
  requestId?: string
  invalid: boolean
}

export function forwardedPushBinding(
  environment: KnownRuntimeEnvironment,
  connection: PairedRuntimeConnection
): string {
  return JSON.stringify([
    environment.createdAt,
    environment.pairingRevision ?? environment.createdAt,
    connection.endpoint,
    connection.hostPublicKeyB64,
    connection.credential,
    connection.pairedDeviceId ?? null
  ])
}

type Content = { buffer: Buffer; value: unknown }

/** Fresh serial bytes are authority; only their unchanged semantic work is retained. */
export function createForwardedPushAuthority(getRoot: () => string) {
  let retained:
    | {
        root: string
        gate: boolean
        contents: Map<string, Content>
        index: Map<string, KnownRuntimeEnvironment>
        qualified: Map<string, { binding: string; origin: string } | undefined>
      }
    | undefined
  const clear = () => {
    retained = undefined
  }
  return {
    clear,
    resolve(source: ForwardedPushSource, isCurrent: () => boolean): string | undefined {
      for (let attempt = 0; attempt < 2; attempt++) {
        const root = getRoot()
        const gate = isWslHostsServing(process.env)
        if (source.invalid || source.root !== root || !isCurrent()) {
          clear()
          return undefined
        }
        const prior = retained?.root === root ? retained : undefined
        const contents = new Map<string, Content>()
        let failed = false
        const readContent: EnvironmentStoreContentReader = (path, limit, decode) => {
          try {
            const buffer = readNodeFileSyncWithinLimit(path, limit).buffer
            const previous = prior?.contents.get(path)
            if (previous?.buffer.equals(buffer)) {
              contents.set(path, previous)
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this private reader serves only three fixed registry paths, each with one shared decoder and unchanged read options.
              return previous.value as ReturnType<typeof decode>
            }
            const value = decode(buffer)
            contents.set(path, { buffer, value })
            return value
          } catch (error) {
            failed = true
            throw error
          }
        }
        try {
          const inputs = readEnvironmentStoreInputs(root, {}, readContent)
          if (root !== getRoot() || gate !== isWslHostsServing(process.env) || !isCurrent()) {
            clear()
            continue
          }
          const unchanged =
            !failed &&
            prior !== undefined &&
            prior.gate === gate &&
            contents.size === prior.contents.size &&
            [...contents].every(([path, content]) => prior.contents.get(path) === content)
          const snapshot =
            unchanged && prior
              ? prior
              : {
                  root,
                  gate,
                  contents,
                  index: new Map<string, KnownRuntimeEnvironment>(),
                  qualified: new Map<string, { binding: string; origin: string } | undefined>()
                }
          if (!unchanged) {
            for (const environment of environmentStoreFromInputs(root, inputs).environments) {
              if (!snapshot.index.has(environment.id)) {
                snapshot.index.set(environment.id, environment)
              }
            }
          }
          if (!snapshot.qualified.has(source.environmentId)) {
            const environment = snapshot.index.get(source.environmentId)
            let qualified: { binding: string; origin: string } | undefined
            if (environment) {
              const keys = [
                ...new Set(environment.endpoints.map((endpoint) => endpoint.publicKeyB64))
              ]
              const spelling = keys[0]
              const key =
                spelling && keys.length === 1 ? Buffer.from(spelling, 'base64') : undefined
              if (key?.length === 32) {
                qualified = {
                  binding: forwardedPushBinding(
                    environment,
                    getPreferredPairedRuntimeConnection(environment)
                  ),
                  origin: deriveRelayHostId(key)
                }
              }
            }
            snapshot.qualified.set(source.environmentId, qualified)
          }
          retained = failed ? undefined : snapshot
          const qualified = snapshot.qualified.get(source.environmentId)
          return qualified &&
            !source.invalid &&
            isCurrent() &&
            root === getRoot() &&
            qualified.binding === source.binding
            ? qualified.origin
            : undefined
        } catch {
          clear()
          return undefined
        }
      }
      clear()
      return undefined
    }
  }
}
