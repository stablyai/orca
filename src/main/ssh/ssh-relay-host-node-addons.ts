/**
 * Rung C of the relay runtime ladder (design D6): the relay runs on the host's own Node
 * (>= 18) with Orca's prebuilt N-API addons uploaded beside it. No npm, no compiler.
 */
import { ORCAD_ADDON_NAPI_VERSION } from '../../shared/orcad-artifacts'
import type { ServerTarget } from '../../shared/node-runtime-pin'
import { materializeOrcadArtifact } from './orcad-artifact-materializer'
import type { GlibcVersion, OrcadDeploymentTargetFacts } from './orcad-deployment-target'
import type { SshConnection } from './ssh-connection'
import {
  isGlibcBelow,
  PINNED_NODE_GLIBC_FLOOR,
  PinnedRelayFallbackError,
  pinnedNodeRelayFullVersion,
  stagePinnedRelayAddons,
  type PinnedRelayAddons,
  type PinnedRelayPlan
} from './ssh-relay-pinned-node'
import { resolveRemoteHostNodeForAddons } from './ssh-remote-node-addon-resolution'
import type { HostNodeAddonFacts } from './ssh-remote-node-toolchain-probe'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { tmpdir } from 'node:os'

/** Folded into the relay version in place of a runtime hash, so C never shares A's dir. */
export const HOST_NODE_RELAY_RUNTIME_KEY = 'host-node'

/** The server slots' addons are built against this glibc, whichever Node loads them. */
export const RELAY_ADDON_GLIBC_FLOOR: GlibcVersion = PINNED_NODE_GLIBC_FLOOR

export type HostNodeAddonRelayPlan = {
  kind: 'host-node-addons'
  target: ServerTarget
  glibc: GlibcVersion | null
  fullVersion: string
  addons: PinnedRelayAddons
  nodePath: string
  hostNode: HostNodeAddonFacts
}

/** A relay launched from uploaded prebuilt addons rather than a host npm install. */
export type PrebuiltRelayPlan = PinnedRelayPlan | HostNodeAddonRelayPlan

export async function planHostNodeAddonRelay(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  facts: OrcadDeploymentTargetFacts
  baseVersion: string
  signal?: AbortSignal
  materializeOrcad?: (target: ServerTarget, signal?: AbortSignal) => Promise<string>
  resolveHostNode?: typeof resolveRemoteHostNodeForAddons
}): Promise<HostNodeAddonRelayPlan> {
  const { conn, host, facts, signal } = options
  if (host.os === 'win32') {
    throw new PinnedRelayFallbackError(
      'windows_host_unsupported',
      'Windows hosts keep the host-Node relay for now'
    )
  }
  if (facts.glibc && isGlibcBelow(facts.glibc, RELAY_ADDON_GLIBC_FLOOR)) {
    throw new PinnedRelayFallbackError(
      'libc_floor',
      `host glibc ${facts.glibc.major}.${facts.glibc.minor} is below the prebuilt addons' floor`
    )
  }
  const resolveHostNode = options.resolveHostNode ?? resolveRemoteHostNodeForAddons
  const hostNode = await resolveHostNode(conn, ORCAD_ADDON_NAPI_VERSION, { signal })
  if (!hostNode) {
    throw new PinnedRelayFallbackError(
      'host_node_missing',
      `no host Node.js 18+ with N-API ${ORCAD_ADDON_NAPI_VERSION} was found`
    )
  }
  let addons: PinnedRelayAddons
  try {
    const materialize =
      options.materializeOrcad ?? ((t, s) => materializeOrcadArtifact(t, { signal: s }))
    addons = await stagePinnedRelayAddons(
      await materialize(facts.target, signal),
      facts.target,
      tmpdir(),
      {
        runtimeRef: false
      }
    )
  } catch (error) {
    signal?.throwIfAborted()
    throw new PinnedRelayFallbackError(
      'artifacts_unavailable',
      error instanceof Error ? error.message : String(error)
    )
  }
  try {
    return {
      kind: 'host-node-addons',
      target: facts.target,
      glibc: facts.glibc,
      fullVersion: pinnedNodeRelayFullVersion(
        options.baseVersion,
        HOST_NODE_RELAY_RUNTIME_KEY,
        addons.digest
      ),
      addons,
      nodePath: hostNode.nodePath,
      hostNode: hostNode.facts
    }
  } catch (error) {
    await addons.dispose()
    throw error
  }
}
