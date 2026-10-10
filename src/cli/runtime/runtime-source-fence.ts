import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import type { RuntimeSourceStamp } from '../../shared/runtime-source-env'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'

type StatusProbe = (metadata: RuntimeMetadata) => Promise<RuntimeRpcResponse<RuntimeStatus>>

/**
 * Refuses, before the request is sent, a runtime other than the one that launched this process.
 * A new incarnation of the same source (restart, update) is accepted so surviving panes keep working.
 */
export class RuntimeSourceFence {
  private readonly verifiedRuntimeIds = new Set<string>()

  constructor(private readonly expected: RuntimeSourceStamp | null) {
    if (expected) {
      this.verifiedRuntimeIds.add(expected.incarnation)
    }
  }

  async check(metadata: RuntimeMetadata, method: string, probe: StatusProbe): Promise<void> {
    // Why status.get is exempt: it is the read-only probe itself.
    if (!this.expected || method === 'status.get') {
      return
    }
    if (this.verifiedRuntimeIds.has(metadata.runtimeId)) {
      return
    }
    // Why trust the answer: the transport rejects a response from any runtime but metadata's.
    const response = await probe(metadata)
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
  }
}
