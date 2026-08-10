import type { SkillDiscoveryResult } from '../../shared/skills'
import { parseSkillDiscoveryResult } from '../../shared/skills'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'

/** Below the renderer's 10s runtime-RPC timeout and above the relay's 8s scan
 *  budget so each layer's classified error outlives the outer deadline. */
const SKILL_DISCOVERY_REQUEST_TIMEOUT_MS = 9_000

/** Old relay without skills.discover; the runtime maps this to the typed
 *  relay-upgrade-required pane response instead of a generic host error. */
export class SshSkillDiscoveryUnsupportedError extends Error {
  constructor() {
    super(
      'This SSH host is running an older Orca relay without skill discovery. Reconnect to deploy the latest relay, then try again.'
    )
    this.name = 'SshSkillDiscoveryUnsupportedError'
  }
}

function isJsonRpcMethodNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  return (error as { code?: unknown }).code === JsonRpcErrorCode.MethodNotFound
}

export class SshSkillDiscoveryProvider {
  constructor(
    private readonly connectionId: string,
    private readonly mux: SshChannelMultiplexer
  ) {}

  getConnectionId(): string {
    return this.connectionId
  }

  async discover(cwd: string, options?: { signal?: AbortSignal }): Promise<SkillDiscoveryResult> {
    let raw: unknown
    try {
      raw = await this.mux.request(
        'skills.discover',
        { cwd },
        { signal: options?.signal, timeoutMs: SKILL_DISCOVERY_REQUEST_TIMEOUT_MS }
      )
    } catch (error) {
      if (isJsonRpcMethodNotFoundError(error)) {
        throw new SshSkillDiscoveryUnsupportedError()
      }
      throw error
    }
    // Why: the relay frame is remote input; validate before it reaches renderer state.
    return parseSkillDiscoveryResult(raw)
  }
}
