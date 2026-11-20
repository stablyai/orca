import type { OrcaRuntimeService } from '../../../orca-runtime'
import { TerminalHandle } from '../../../../../shared/rpc-contract/terminal/terminal-unary-params'
import { defineMethod } from '../../core'

type TerminalCwdHost = Pick<
  OrcaRuntimeService,
  'resolveLiveLeafForHandle' | 'getPtyExecutionHostMetadata' | 'resolveTerminalCwd'
>

export async function readRuntimeTerminalCwd(
  host: TerminalCwdHost,
  params: { terminal: string; expectedIncarnationId?: string }
): Promise<{ cwd: string | null }> {
  const ptyId = host.resolveLiveLeafForHandle(params.terminal)?.ptyId
  if (!ptyId) {
    return { cwd: null }
  }
  const incarnationId = host.getPtyExecutionHostMetadata(ptyId).incarnationId ?? null
  if (params.expectedIncarnationId && params.expectedIncarnationId !== incarnationId) {
    throw new Error('terminal_handle_stale')
  }
  const cwd = await host.resolveTerminalCwd(params.terminal)
  // A directory observed before a pane replacement belongs to the old process.
  if (
    host.resolveLiveLeafForHandle(params.terminal)?.ptyId !== ptyId ||
    (host.getPtyExecutionHostMetadata(ptyId).incarnationId ?? null) !== incarnationId
  ) {
    throw new Error('terminal_handle_stale')
  }
  return { cwd }
}

export const TERMINAL_CWD_METHOD = defineMethod({
  name: 'terminal.cwd',
  permission: 'workspace',
  params: TerminalHandle,
  handler: (params, { runtime }) => readRuntimeTerminalCwd(runtime, params)
})
