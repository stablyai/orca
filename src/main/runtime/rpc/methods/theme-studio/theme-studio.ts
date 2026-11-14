import { defineMethod, type RpcContext } from '../../core'
import {
  ThemeStudioAdjustParams,
  ThemeStudioApplyParams,
  ThemeStudioCallerParams,
  ThemeStudioCheckParams,
  ThemeStudioEditParams,
  ThemeStudioPatchParams,
  ThemeStudioShotParams,
  ThemeStudioStatusParams,
  ThemeStudioStepParams
} from '../../../../../shared/rpc-contract/theme-studio/theme-studio-params'
import {
  THEME_STUDIO_ERROR_CODES,
  ThemeStudioError
} from '../../../../../shared/theme-studio/theme-studio-errors'
import type {
  ThemeStudioCaller,
  ThemeStudioService
} from '../../../../theme-studio/theme-studio-service'

// Desktop only: a headless `orca serve` has no window to paint a draft in.
let themeStudioForRpc: ThemeStudioService | null = null

export function setThemeStudioForRpc(service: ThemeStudioService | null): void {
  themeStudioForRpc = service
}

function requireThemeStudio(): ThemeStudioService {
  if (!themeStudioForRpc) {
    throw new ThemeStudioError(
      THEME_STUDIO_ERROR_CODES.needsDesktop,
      'This Orca has no window to paint a theme in.',
      {
        nextSteps: [
          'Run `orca theme` from a terminal of the Orca desktop app you look at, or pass `--environment` for an Orca desktop server.'
        ]
      }
    )
  }
  return themeStudioForRpc
}

/** The caller as history and the notice name it ("claude · Terminal 2"); a terminal the host
 *  cannot find still limits its own rate. */
async function callerOf(
  params: { terminal?: string; ifRevision?: number },
  context: RpcContext
): Promise<ThemeStudioCaller> {
  const key = params.terminal ?? context.connectionId ?? context.clientId ?? 'local'
  const base = {
    key,
    ...(params.ifRevision === undefined ? {} : { ifRevision: params.ifRevision })
  }
  if (!params.terminal) {
    return base
  }
  const terminal = await context.runtime.showTerminal(params.terminal).catch(() => null)
  const pane = terminal?.paneTitle ?? terminal?.title
  return terminal
    ? { ...base, by: [terminal.agentIdentity ?? 'agent', pane].filter(Boolean).join(' · ') }
    : base
}

// Why host-admin: a draft repaints the whole app for everyone looking at this window.
export const THEME_STUDIO_METHODS = [
  defineMethod({
    name: 'themeStudio.status',
    permission: 'host-admin',
    params: ThemeStudioStatusParams,
    handler: async (params) =>
      requireThemeStudio().status({
        resolved: params.resolved === true,
        report: params.report !== false
      })
  }),
  defineMethod({
    name: 'themeStudio.edit',
    permission: 'host-admin',
    params: ThemeStudioEditParams,
    handler: async (params, context) =>
      requireThemeStudio().edit(params, await callerOf(params, context))
  }),
  defineMethod({
    name: 'themeStudio.patch',
    permission: 'host-admin',
    params: ThemeStudioPatchParams,
    handler: async (params, context) =>
      requireThemeStudio().patch(
        params.patch,
        params.label ?? 'Set tokens',
        await callerOf(params, context)
      )
  }),
  defineMethod({
    name: 'themeStudio.adjust',
    permission: 'host-admin',
    params: ThemeStudioAdjustParams,
    handler: async (params, context) =>
      requireThemeStudio().adjust(params, await callerOf(params, context))
  }),
  defineMethod({
    name: 'themeStudio.check',
    permission: 'host-admin',
    params: ThemeStudioCheckParams,
    handler: async (params, context) =>
      requireThemeStudio().check(
        params.fix === true,
        params.findings,
        await callerOf(params, context)
      )
  }),
  defineMethod({
    name: 'themeStudio.step',
    permission: 'host-admin',
    params: ThemeStudioStepParams,
    handler: async (params, context) =>
      requireThemeStudio().step(params.direction, await callerOf(params, context))
  }),
  defineMethod({
    name: 'themeStudio.reset',
    permission: 'host-admin',
    params: ThemeStudioCallerParams,
    handler: async (params, context) => requireThemeStudio().reset(await callerOf(params, context))
  }),
  defineMethod({
    // Renderer state only: the window is never shown, raised or focused.
    name: 'themeStudio.shot',
    permission: 'host-admin',
    params: ThemeStudioShotParams,
    handler: async (params) => requireThemeStudio().shot(params.mode)
  }),
  defineMethod({
    name: 'themeStudio.apply',
    permission: 'host-admin',
    params: ThemeStudioApplyParams,
    handler: async (params, context) =>
      requireThemeStudio().apply(params.name, await callerOf(params, context))
  }),
  defineMethod({
    name: 'themeStudio.discard',
    permission: 'host-admin',
    params: ThemeStudioCallerParams,
    handler: async (params, context) =>
      requireThemeStudio().discard(await callerOf(params, context))
  })
]
