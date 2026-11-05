import { withSpan } from '../../observability/tracer'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { RpcContext } from './core'

type TerminalCloseMethod = 'terminal.close' | 'terminal.closeTab'
type TerminalCloseTargetKind = 'terminal' | 'terminal-tab'

export function withTerminalCloseAttribution(
  method: TerminalCloseMethod,
  context: Pick<
    RpcContext,
    'runtime' | 'clientKind' | 'pairedDeviceId' | 'connectionId' | 'requestId'
  >,
  targetKind: TerminalCloseTargetKind,
  terminal: string,
  close: () => Promise<RuntimeTerminalClose>
): Promise<RuntimeTerminalClose> {
  return withSpan(
    method,
    async (span) => {
      span.setAttribute('decision', 'allowed')
      try {
        const result = await close()
        span.setAttribute('outcome', 'succeeded')
        span.setAttribute('tabId', result.tabId)
        span.setAttribute('ptyKilled', result.ptyKilled)
        if (result.closeMode) {
          span.setAttribute('closeMode', result.closeMode)
        }
        return result
      } catch (error) {
        span.setAttribute('outcome', 'failed')
        throw error
      }
    },
    {
      kind: 'client',
      attributes: {
        attribution: 'terminal-close',
        runtimeId: context.runtime.getRuntimeId(),
        origin: context.clientKind ?? 'in-process',
        deviceId: context.pairedDeviceId ?? 'in-process',
        connectionGeneration: context.connectionId ?? 'in-process',
        requestId: context.requestId ?? 'in-process',
        targetKind,
        terminal
      }
    }
  )
}
