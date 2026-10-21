import { useMemo } from 'react'
import {
  getAppBackgroundHostProps,
  resolveAppBackgroundAppearance,
  type AppBackgroundAppearance,
  type AppBackgroundHostProps
} from '@/lib/app-background-appearance'
import type { AppBackgroundScope } from '../../../shared/app-background-settings'
import {
  useAppBackgroundBlobState,
  type AppBackgroundLayerProps
} from '../components/app-background/AppBackgroundLayer'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '../store'

/** Applied (not draft) background settings; null when no image is saved or on the web client. */
export function useAppBackgroundAppearance(): AppBackgroundAppearance | null {
  const appBackgroundImageId = useAppStore((s) => s.settings?.appBackgroundImageId)
  const appBackgroundScope = useAppStore((s) => s.settings?.appBackgroundScope)
  const appBackgroundImageOpacity = useAppStore((s) => s.settings?.appBackgroundImageOpacity)
  const appBackgroundBlur = useAppStore((s) => s.settings?.appBackgroundBlur)
  const appBackgroundPanelOpacity = useAppStore((s) => s.settings?.appBackgroundPanelOpacity)
  return useMemo(
    () =>
      resolveAppBackgroundAppearance(
        {
          appBackgroundImageId,
          appBackgroundScope,
          appBackgroundImageOpacity,
          appBackgroundBlur,
          appBackgroundPanelOpacity
        },
        isWebClientLocation()
      ),
    [
      appBackgroundImageId,
      appBackgroundScope,
      appBackgroundImageOpacity,
      appBackgroundBlur,
      appBackgroundPanelOpacity
    ]
  )
}

export type ScopedAppBackground = {
  host: AppBackgroundHostProps
  layer: AppBackgroundLayerProps
}

/** Host props and layer props once the applied background for `scope` has loaded; null otherwise. */
export function useScopedAppBackground(scope: AppBackgroundScope): ScopedAppBackground | null {
  const appearance = useAppBackgroundAppearance()
  const target = appearance?.scope === scope ? appearance : null
  // Why: a missing or still-loading image must not leave translucent panels over nothing.
  const loaded =
    useAppBackgroundBlobState(target ? { id: target.imageId } : null)?.status === 'loaded'
  return useMemo(() => {
    if (!target || !loaded) {
      return null
    }
    return {
      host: getAppBackgroundHostProps(scope, target.panelOpacity),
      layer: {
        imageId: target.imageId,
        imageOpacity: target.imageOpacity,
        blur: target.blur
      }
    }
  }, [target, loaded, scope])
}
