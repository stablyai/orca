import { withSpan } from '../../observability/tracer'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { RpcContext } from './core'

type TerminalCloseMethod = 'terminal.close' | 'terminal.closeTab'
type TerminalCloseTargetKind = 'terminal' | 'terminal-tab'

type TerminalPresence =
  | { state: 'present'; tabId: string }
  | { state: 'absent' }
  | { state: 'unknown' }

type TerminalCloseTarget = { tabId: string } | null

/**
 * Resolves exact-handle terminal presence from the authoritative runtime inventory.
 */
async function attestTerminalPresence(
  context: Pick<RpcContext, 'runtime'>,
  terminal: string
): Promise<TerminalPresence> {
  try {
    const listed = await context.runtime.listTerminals(undefined, 1, {
      handles: [terminal],
      includeVisualLayouts: false
    })
    if (!listed.hostScope || listed.hostScope.omittedHostIds.length > 0) {
      return { state: 'unknown' }
    }
    const match = listed.terminals.find((candidate) => candidate.handle === terminal)
    return match ? { state: 'present', tabId: match.tabId } : { state: 'absent' }
  } catch {
    return { state: 'unknown' }
  }
}

/**
 * Identifies the runtime close race where the terminal surface has already retired.
 */
function isTabNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === 'tab_not_found'
}

/** Records result fields shared by ordinary and reconciled terminal closes. */
function recordCloseResult(
  span: { setAttribute(key: string, value: string | number | boolean): void },
  result: RuntimeTerminalClose,
  outcome: string
): RuntimeTerminalClose {
  span.setAttribute('outcome', outcome)
  if (result.tabId) {
    span.setAttribute('tabId', result.tabId)
  }
  span.setAttribute('ptyKilled', result.ptyKilled)
  if (result.closeMode) {
    span.setAttribute('closeMode', result.closeMode)
  }
  return result
}

/**
 * Wraps terminal close RPCs with attribution and reconciles tab_not_found races against inventory.
 */
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
      const before: TerminalCloseTarget = context.runtime.getTerminalCloseTarget(terminal)
      try {
        const result = await close()
        return recordCloseResult(span, { ...result, outcome: 'closed' }, 'succeeded')
      } catch (error) {
        if (isTabNotFound(error)) {
          const after = await attestTerminalPresence(context, terminal)
          if (before && after.state === 'absent') {
            const result: RuntimeTerminalClose = {
              handle: terminal,
              tabId: before.tabId,
              outcome: 'closed',
              ...(method === 'terminal.closeTab' ? { closeMode: 'tab' as const } : {}),
              ptyKilled: false
            }
            return recordCloseResult(span, result, 'succeeded-after-retirement')
          }
          if (!before && after.state === 'absent') {
            return recordCloseResult(
              span,
              { handle: terminal, outcome: 'already_absent', ptyKilled: false },
              'already-absent'
            )
          }
        }
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
