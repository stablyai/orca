import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import { linearListDeliveryFailure } from '../runtime/rpc/linear-list-reply-budget'
import { parseRemoteCliArgs } from './ssh-remote-cli-args'
import type { JsonRpcRequest, JsonRpcResponse } from './relay-protocol'
import type { RpcRequest } from '../runtime/rpc/core'

export type LinearListDeliveryContext = {
  signal: AbortSignal
  retainUntilDelivery: (release: () => void) => void
}

export class LinearListSshDelivery implements LinearListDeliveryContext {
  private readonly controller = new AbortController()
  private readonly retained = new Set<() => void>()
  private settled = false
  readonly signal = this.controller.signal
  private constructor(
    private readonly input: RpcRequest,
    private readonly json: boolean
  ) {}

  static forRequest(request: JsonRpcRequest): LinearListSshDelivery | undefined {
    if (request.method !== 'orca.cli' || !Array.isArray(request.params?.argv)) {
      return undefined
    }
    const argv = request.params.argv
    if (!argv.every((value): value is string => typeof value === 'string')) {
      return undefined
    }
    const parsed = parseRemoteCliArgs(argv)
    if (parsed.commandPath.join(' ') !== 'linear list-issues' || parsed.flags.has('help')) {
      return undefined
    }
    const continuation = parsed.flags.get('page-recovery')
    return new LinearListSshDelivery(
      {
        id: 'remote-cli',
        authToken: '',
        method: 'linear.mcpListIssues',
        params: {
          workspaceId: parsed.flags.get('workspace'),
          cursor: parsed.flags.get('cursor'),
          ...(typeof continuation === 'string'
            ? { pageRecovery: { version: 1, continuation } }
            : {})
        }
      },
      parsed.flags.has('json')
    )
  }

  readonly retainUntilDelivery = (release: () => void): void => {
    if (this.settled) {
      release()
    } else {
      this.retained.add(release)
    }
  }

  readonly finish = (): void => {
    this.settled = true
    for (const release of this.retained) {
      release()
    }
    this.retained.clear()
  }

  readonly abort = (): void => {
    this.controller.abort()
    this.finish()
  }

  bound(response: JsonRpcResponse): JsonRpcResponse {
    try {
      if (response.error) {
        throw new Error('Linear reply failed')
      }
      if (!Number.isSafeInteger(response.id)) {
        throw new Error('invalid correlation')
      }
      stringifyJsonWithinByteLimit(response, 2_129_919, 2)
      stringifyJsonWithinByteLimit(response, 2_129_920)
      return response
    } catch {
      const failure = linearListDeliveryFailure(this.input)
      return {
        jsonrpc: '2.0',
        id: Number.isSafeInteger(response.id) ? response.id : 0,
        result: {
          stdout: this.json ? `${JSON.stringify(failure, null, 2)}\n` : '',
          stderr: this.json
            ? ''
            : 'Linear reply could not be delivered; retry the input position or restart concrete workspaces and reconcile by issue ID.\n',
          exitCode: 1
        }
      }
    }
  }
}
