import { protocol } from 'electron'
import {
  PLUGIN_IMAGE_SCHEME,
  parsePluginImageUrl
} from '../../shared/plugins/images/plugin-image-url'
import { pluginThemeBackgroundPath } from './contributions/plugin-theme-background-image'
import { readCheckedPluginImage, type CheckedPluginImage } from './plugin-image-read'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { declaredPluginImages } from './plugin-image-artifact-validation'
import type { PluginImageCache } from './plugin-image-cache'
import { readPluginFontSlot, type CheckedPluginFont } from './plugin-font-files'
import { parsePluginFontSlot } from '../../shared/plugins/contributions/plugin-font-contribution'

export type PluginImageProtocolDependencies = {
  cache: PluginImageCache
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  /** Enabled and consented; fonts are served only for these. */
  findApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
}

function isCurrentContent(plugin: ValidDiscoveredPlugin, contentHash: string): boolean {
  return contentHash === (plugin.isDev ? 'dev' : plugin.contentHash)
}

/** An installed plugin's declared image or theme background, re-checked on every read like at install. */
async function readInstalledImage(
  plugin: ValidDiscoveredPlugin,
  contentHash: string,
  slot: string
): Promise<CheckedPluginImage | null> {
  if (!isCurrentContent(plugin, contentHash)) {
    return null
  }
  const declared = declaredPluginImages(plugin.manifest).find(
    (candidate) => candidate.slot === slot
  )
  if (declared) {
    return readCheckedPluginImage(plugin.rootDir, declared.kind, declared.path)
  }
  const themeBackground = await pluginThemeBackgroundPath(plugin, slot)
  return themeBackground
    ? readCheckedPluginImage(plugin.rootDir, 'theme-background', themeBackground)
    : null
}

export function createPluginImageRequestHandler(
  dependencies: PluginImageProtocolDependencies
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 })
    }
    const reference = parsePluginImageUrl(request.url)
    try {
      let asset: CheckedPluginImage | CheckedPluginFont | null = null
      const isFont = reference?.kind === 'installed' && parsePluginFontSlot(reference.slot) !== null
      if (reference?.kind === 'sha') {
        asset = await dependencies.cache.get(reference.sha256)
      } else if (reference?.kind === 'installed' && isFont) {
        const plugin = dependencies.findApprovedPlugin(reference.pluginKey)
        asset =
          plugin && isCurrentContent(plugin, reference.contentHash)
            ? await readPluginFontSlot(plugin.rootDir, plugin.manifest, reference.slot)
            : null
      } else if (reference?.kind === 'installed') {
        const plugin = dependencies.findValidPlugin(reference.pluginKey)
        asset = plugin
          ? await readInstalledImage(plugin, reference.contentHash, reference.slot)
          : null
      }
      if (!asset) {
        return new Response(null, { status: 404 })
      }
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(asset.bytes), {
        headers: {
          'Content-Type': asset.mimeType,
          'Content-Length': String(asset.bytes.byteLength),
          // Why immutable is safe: a hash or install hash names exact bytes; dev trees change in place.
          'Cache-Control':
            reference?.kind === 'installed' && reference.contentHash === 'dev'
              ? 'no-store'
              : 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          // Why: web fonts load in CORS mode; only the default session handles this scheme, so
          // plugin frames and browser tabs, which use their own sessions, still cannot reach it.
          ...(isFont ? { 'Access-Control-Allow-Origin': '*' } : {})
        }
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  }
}

export function installPluginImageProtocolHandler(
  dependencies: PluginImageProtocolDependencies
): void {
  protocol.handle(PLUGIN_IMAGE_SCHEME, createPluginImageRequestHandler(dependencies))
}
