import { defineMethod } from '../../core'
import {
  ThemeStudioAdjustParams,
  ThemeStudioApplyParams,
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
import type { ThemeStudioService } from '../../../../theme-studio/theme-studio-service'

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

// Why host-admin: a draft repaints the whole app for everyone looking at this window.
export const THEME_STUDIO_METHODS = [
  defineMethod({
    name: 'themeStudio.status',
    permission: 'host-admin',
    params: ThemeStudioStatusParams,
    handler: async (params) => requireThemeStudio().status(params.resolved === true)
  }),
  defineMethod({
    name: 'themeStudio.edit',
    permission: 'host-admin',
    params: ThemeStudioEditParams,
    handler: async (params) => requireThemeStudio().edit(params)
  }),
  defineMethod({
    name: 'themeStudio.patch',
    permission: 'host-admin',
    params: ThemeStudioPatchParams,
    handler: async (params) =>
      requireThemeStudio().patch(params.patch, params.label ?? 'Set tokens')
  }),
  defineMethod({
    name: 'themeStudio.adjust',
    permission: 'host-admin',
    params: ThemeStudioAdjustParams,
    handler: async (params) => requireThemeStudio().adjust(params)
  }),
  defineMethod({
    name: 'themeStudio.check',
    permission: 'host-admin',
    params: ThemeStudioCheckParams,
    handler: async (params) => requireThemeStudio().check(params.fix === true)
  }),
  defineMethod({
    name: 'themeStudio.step',
    permission: 'host-admin',
    params: ThemeStudioStepParams,
    handler: async (params) => requireThemeStudio().step(params.direction)
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
    handler: async (params) => requireThemeStudio().apply(params.name)
  }),
  defineMethod({
    name: 'themeStudio.discard',
    permission: 'host-admin',
    params: null,
    handler: async () => requireThemeStudio().discard()
  })
]
