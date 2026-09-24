import { useEffect } from 'react'
import type { CustomCssSnapshot } from '../../../shared/custom-css'
import { applyCustomCssSheet, buildCustomCssSheet } from '@/lib/custom-css-sheet'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '../store'

/** Applies `~/.orca/custom.css` to this window while the setting is on, following edits live. */
export function useCustomCss(): void {
  const enabled = useAppStore((s) => s.settings?.customCssEnabled === true)

  useEffect(() => {
    // Why: the paired web client cannot reach the host's ~/.orca folder.
    if (!enabled || isWebClientLocation()) {
      return
    }
    let disposed = false
    let appliedCss: string | null = null
    const apply = (snapshot: CustomCssSnapshot | undefined): void => {
      if (disposed || !snapshot || snapshot.css === appliedCss) {
        return
      }
      appliedCss = snapshot.css
      applyCustomCssSheet(document, snapshot.css ? buildCustomCssSheet(snapshot.css) : null)
    }
    const offChanged = window.api.customCss.onChanged(apply)
    void Promise.resolve(window.api.customCss.get())
      .then(apply)
      .catch((error: unknown) => console.warn('[custom-css] failed to load', error))
    return () => {
      disposed = true
      offChanged()
      applyCustomCssSheet(document, null)
    }
  }, [enabled])
}
