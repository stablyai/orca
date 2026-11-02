import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { isSameUserDataPath } from '../../shared/serve-user-data-path'
import { readRuntimeSourceStamp, type RuntimeSourceStamp } from '../../shared/runtime-source-env'
import type { ExpectedRuntimeSource } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { getPlatformUserDataPath } from './metadata'
import { sendRequest } from './transport'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'

type StatusProbe = (metadata: RuntimeMetadata) => Promise<RuntimeRpcResponse<RuntimeStatus>>

/**
 * The stamp to enforce for a CLI dialing `userDataPath`. Explicitly choosing another profile (e.g.
 * `orca-dev` from a packaged Orca's terminal) is the user's target, not a fallback, so it is not fenced.
 */
export function resolveFencedRuntimeSource(
  stamp: RuntimeSourceStamp | null,
  userDataPath: string,
  platformDefaultPath: string | null
): RuntimeSourceStamp | null {
  if (!stamp?.profilePath || isSameUserDataPath(userDataPath, stamp.profilePath)) {
    return stamp
  }
  // Why: the platform default is what an unpinned terminal falls back to, which is the case to fence.
  return platformDefaultPath !== null && isSameUserDataPath(userDataPath, platformDefaultPath)
    ? stamp
    : null
}

/**
 * Refuses, before the request is sent, a runtime other than the one that launched this process.
 * A new incarnation of the same source (restart, update) is accepted so surviving panes keep working.
 * Returns what the request must carry so the host itself refuses it if it is not that runtime.
 */
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

  async check(
    metadata: RuntimeMetadata,
    method: string
  ): Promise<ExpectedRuntimeSource | undefined> {
    // Why status.get is exempt: it is the read-only probe itself.
    if (!this.expected || method === 'status.get') {
      return undefined
    }
    const expectation = { sourceId: this.expected.sourceId, runtimeId: metadata.runtimeId }
    if (this.verifiedRuntimeIds.has(metadata.runtimeId)) {
      return expectation
    }
    // Why trust the answer: the transport rejects a response from any runtime but metadata's.
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
    // Why: no resolvable default (Windows without APPDATA) means nothing can fall back to it.
  }
  return new RuntimeSourceFence(
    resolveFencedRuntimeSource(readRuntimeSourceStamp(env), userDataPath, platformDefaultPath),
    (metadata) => sendRequest<RuntimeStatus>(metadata, 'status.get', undefined, probeTimeoutMs)
  )
}
