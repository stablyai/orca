import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../../../shared/plugins/workers/plugin-host-api-workspace-context'
import { PLUGIN_HOST_ID_MAX_LENGTH } from '../../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import { PluginHostCallError } from './plugin-host-call-scope'
import type { PluginHostServices } from './plugin-host-method-bindings'
import { forgetPluginOpenedTerminal, isPluginOpenedTerminal } from './plugin-opened-terminals'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'
import { pluginTerminalTitle } from './plugin-workspace-projection'
import {
  pluginHostEffect as effect,
  pluginHostRenderer as renderer,
  pluginHostRpc as rpc,
  pluginWorkspaceSelector as workspaceSelector
} from './plugin-host-runtime-call'

const api = PLUGIN_HOST_API

// The parts of each runtime answer a host method reads; anything else is dropped.
const terminalListAnswer = z.object({
  terminals: z.array(
    z.object({
      handle: z.string(),
      title: z.string().nullable(),
      paneTitle: z.string().optional()
    })
  ),
  totalCount: z.number().optional(),
  truncated: z.boolean().optional()
})
const terminalCloseAnswer = z.object({
  close: z.object({
    ptyKilled: z.boolean(),
    ptyStopVerdict: z.enum(['live', 'unverifiable']).optional()
  })
})

export const TERMINAL_CLOSE_REFUSAL =
  'terminal.close closes only terminals of the focused workspace or ones this plugin opened'

/** Whether the terminal belongs to the focused workspace now, as `terminal.sendText` checks. */
async function inFocusedWorkspace(
  services: PluginHostServices,
  terminalId: string
): Promise<boolean> {
  const context = await services.resolveActiveWorktreeContext()
  if (!context) {
    return false
  }
  const terminals = await services.listWorktreeTerminals(context.worktreeId).catch(() => [])
  return terminals.some((terminal) => terminal.id === terminalId)
}

export const PLUGIN_TERMINAL_ACTION_HANDLERS = {
  'terminal.list': bind(api['terminal.list'], async ({ workspaceId }, { services, scope }) => {
    const answer = await rpc(services)(
      'terminal.list',
      {
        worktree: workspaceSelector(workspaceId),
        limit: PLUGIN_WORKSPACE_TERMINAL_LIMIT,
        includeVisualLayouts: false,
        includePreview: false
      },
      scope.signal ? { signal: scope.signal } : {}
    )
    const { terminals, totalCount, truncated } = terminalListAnswer.parse(answer)
    // Why filter: one over-long handle must not fail the whole list; it counts as left out.
    const listed = terminals
      .slice(0, PLUGIN_WORKSPACE_TERMINAL_LIMIT)
      .filter(({ handle }) => handle.length > 0 && handle.length <= PLUGIN_HOST_ID_MAX_LENGTH)
    return {
      terminals: listed.map((terminal) => {
        const title = pluginTerminalTitle(terminal)
        return title ? { id: terminal.handle, title } : { id: terminal.handle }
      }),
      truncated: truncated === true || (totalCount ?? terminals.length) > listed.length
    }
  }),
  'terminal.focus': bind(api['terminal.focus'], async ({ terminalId }, ctx) => {
    // Focus means Orca's window; headless serve has none to show.
    renderer(ctx.services)
    // `navigated: false` in the answer means a later request for this terminal won; it is shown.
    await effect(ctx, 'terminal.focus', {
      terminal: terminalId,
      // This window only: paired phones and other clients are not steered by a plugin.
      navigation: 'host'
    })
    return { focused: true as const }
  }),
  'terminal.close': bind(api['terminal.close'], async ({ terminalId }, ctx) => {
    // Destructive, so narrower than focus: the focused workspace's terminals (where
    // `terminal.sendText` may type), or ones this plugin opened wherever they are.
    if (
      !isPluginOpenedTerminal(ctx.pluginId, terminalId) &&
      !(await inFocusedWorkspace(ctx.services, terminalId))
    ) {
      throw new PluginHostCallError('action_failed', TERMINAL_CLOSE_REFUSAL)
    }
    const { close } = terminalCloseAnswer.parse(
      await effect(ctx, 'terminal.close', { terminal: terminalId })
    )
    forgetPluginOpenedTerminal(ctx.pluginId, terminalId)
    // No verdict and no kill: the terminal had no running process (it already exited).
    return { closed: true as const, processExited: close.ptyKilled || !close.ptyStopVerdict }
  })
} satisfies Record<string, BoundPluginHostMethod>
