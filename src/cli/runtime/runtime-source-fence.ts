import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { isSameUserDataPath } from '../../shared/serve-user-data-path'
import { readRuntimeSourceStamp, type RuntimeSourceStamp } from '../../shared/runtime-source-env'
import type { ExpectedRuntimeSource } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { getPlatformUserDataPath } from './metadata'
import { sendRequest } from './transport'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'

type StatusProbe = (metadata: RuntimeMetadata) => Promise<RuntimeRpcResponse<RuntimeStatus>>

/** A different nondefault profile opts out of the inherited runtime fence. */
export function resolveFencedRuntimeSource(
  stamp: RuntimeSourceStamp | null,
  userDataPath: string,
  platformDefaultPath: string | null
): RuntimeSourceStamp | null {
  if (!stamp?.profilePath || isSameUserDataPath(userDataPath, stamp.profilePath)) {
    return stamp
  }
  // Fence unpinned terminals falling back to the platform default.
  return platformDefaultPath !== null && isSameUserDataPath(userDataPath, platformDefaultPath)
    ? stamp
    : null
}

/** Fence requests to their launching source, allowing new incarnations after restarts and updates. */
export class RuntimeSourceFence {
  private readonly verifiedRuntimeIds = new Set<string>()

  constructor(
    private readonly expected: RuntimeSourceStamp | null,
    private readonly probe: StatusProbe
  ) {
    if (expected) {
      this.verifiedRuntimeIds.add(expected.incarnation)
    }
  }

  /** Rejects a changed runtime before probing and reconciles explicit and inherited profile pins. */
  async check(
    metadata: RuntimeMetadata,
    method: string,
    pinnedSource?: ExpectedRuntimeSource
  ): Promise<ExpectedRuntimeSource | undefined> {
    if (pinnedSource && metadata.runtimeId !== pinnedSource.runtimeId) {
      throw new RuntimeClientError(
        'runtime_source_mismatch',
        'The pinned runtime changed. Nothing was sent.'
      )
    }
    const inheritedSource = await this.checkLaunchingSource(metadata, method)
    if (pinnedSource && inheritedSource && pinnedSource.sourceId !== inheritedSource.sourceId) {
      throw new RuntimeClientError(
        'runtime_source_mismatch',
        'The pinned profile differs from the launching profile. Nothing was sent.'
      )
    }
    return pinnedSource ?? inheritedSource
  }

  /** Verifies uncached runtime incarnations still serve the launching profile before admitting them. */
  private async checkLaunchingSource(
    metadata: RuntimeMetadata,
    method: string
  ): Promise<ExpectedRuntimeSource | undefined> {
    // status.get is the read-only probe itself.
    if (!this.expected || method === 'status.get') {
      return undefined
    }
    const expectation = { sourceId: this.expected.sourceId, runtimeId: metadata.runtimeId }
    if (this.verifiedRuntimeIds.has(metadata.runtimeId)) {
      return expectation
    }
    // The transport verifies that this response came from metadata’s runtime.
    const response = await this.probe(metadata)
    if (response.ok === false) {
      throw new RuntimeClientError(
        'runtime_source_unverifiable',
        `Could not confirm that the running Orca is the one that launched this terminal: ${response.error.message}`
      )
    }
    const sourceId = response.result.hostDescriptor?.installationId
    if (!sourceId) {
      throw new RuntimeClientError(
        'runtime_source_unverifiable',
        'The running Orca does not report which profile it serves, so this terminal cannot confirm it is the Orca that launched it. Nothing was sent. Open a new terminal from the Orca you want to control.'
      )
    }
    if (sourceId !== this.expected.sourceId) {
      throw new RuntimeClientError(
        'runtime_source_mismatch',
        'The running Orca is not the one that launched this terminal (another profile or instance took over its runtime record). Nothing was sent. Open a new terminal from the Orca you want to control.'
      )
    }
    this.verifiedRuntimeIds.add(metadata.runtimeId)
    return expectation
  }
}

export function createRuntimeSourceFence(
  env: Readonly<Record<string, string | undefined>>,
  userDataPath: string,
  probeTimeoutMs: number
): RuntimeSourceFence {
  let platformDefaultPath: string | null = null
  try {
    platformDefaultPath = getPlatformUserDataPath()
  } catch {
    // Without a platform default, no terminal can fall back to it.
  }
  return new RuntimeSourceFence(
    resolveFencedRuntimeSource(readRuntimeSourceStamp(env), userDataPath, platformDefaultPath),
    (metadata) => sendRequest<RuntimeStatus>(metadata, 'status.get', undefined, probeTimeoutMs)
  )
}
