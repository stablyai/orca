import { withSpan } from '../../observability/tracer'
import type { RpcContext } from './core'

type TerminalCloseMethod = 'terminal.close' | 'terminal.closeTab'
type TerminalCloseTargetKind = 'terminal' | 'terminal-tab'

export function withTerminalCloseAttribution<T>(
  method: TerminalCloseMethod,
  context: Pick<RpcContext, 'clientKind' | 'pairedDeviceId' | 'connectionId' | 'requestId'>,
  targetKind: TerminalCloseTargetKind,
  terminal: string,
  close: () => Promise<T>
): Promise<T> {
  return withSpan(
    method,
    async (span) => {
      const result = await close()
      span.setAttribute('decision', 'allowed')
      return result
    },
    {
      kind: 'client',
      attributes: {
        attribution: 'terminal-close',
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
