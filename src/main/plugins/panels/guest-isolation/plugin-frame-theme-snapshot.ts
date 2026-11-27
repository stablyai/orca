import { z } from 'zod'
import type { PluginFrameTheme } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'

/** The renderer's theme as of its latest frame open, so a guest's first paint already matches. */
export const pluginFrameThemeSchema = lazyZodSchema(() =>
  z.object({
    colorScheme: z.enum(['light', 'dark']),
    tokens: z.string().max(16 * 1024)
  })
)

let latest: PluginFrameTheme | null = null

export function notePluginFrameTheme(theme: PluginFrameTheme | undefined): void {
  if (theme) {
    // Why strip again: the value lands inside a <style> element main serves.
    latest = { colorScheme: theme.colorScheme, tokens: theme.tokens.replace(/[{}<>]/g, '') }
  }
}

export function currentPluginFrameThemeSnapshot(): PluginFrameTheme | null {
  return latest
}
