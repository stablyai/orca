import { protocol } from 'electron'
import {
  PLUGIN_IMAGE_SCHEME,
  parsePluginImageUrl
} from '../../../shared/plugins/images/plugin-image-url'
import { pluginThemeBackgroundFile } from '../contributions/plugin-theme-background-image'
import { readCheckedPluginImage, type CheckedPluginImage } from './plugin-image-read'
import { readCheckedPluginThemeVideo } from './plugin-theme-video-read'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'
import { declaredPluginImages } from './plugin-image-artifact-validation'
import type { PluginImageCache } from './plugin-image-cache'
import { readPluginFontSlot, type CheckedPluginFont } from './plugin-font-files'
import { parsePluginFontSlot } from '../../../shared/plugins/contributions/plugin-font-contribution'
import { declaredPluginPanelIcons, readCheckedPluginPanelIcon } from './plugin-panel-icon-artifacts'

export type PluginImageProtocolDependencies = {
  cache: PluginImageCache
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  /** Enabled and consented; fonts and panel icons are served only for these. */
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
  const panelIcon = declaredPluginPanelIcons(plugin.manifest).find(
    (candidate) => candidate.slot === slot
  )
  if (panelIcon) {
    return readCheckedPluginPanelIcon(plugin.rootDir, panelIcon.path)
  }
  const declared = declaredPluginImages(plugin.manifest).find(
    (candidate) => candidate.slot === slot
  )
  if (declared) {
    return readCheckedPluginImage(plugin.rootDir, declared.kind, declared.path)
  }
  const themeBackground = await pluginThemeBackgroundFile(plugin, slot)
  if (!themeBackground) {
    return null
  }
  return themeBackground.video
    ? readCheckedPluginThemeVideo(plugin.rootDir, themeBackground.path)
    : readCheckedPluginImage(plugin.rootDir, 'theme-background', themeBackground.path)
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
      const isPanelIcon =
        reference?.kind === 'installed' && reference.slot.startsWith('panel-icon-')
      const needsApproval = isFont || isPanelIcon
      const findPlugin = needsApproval
        ? dependencies.findApprovedPlugin
        : dependencies.findValidPlugin
      const plugin = reference?.kind === 'installed' ? findPlugin(reference.pluginKey) : null
      if (reference?.kind === 'sha') {
        asset = await dependencies.cache.get(reference.sha256)
      } else if (reference?.kind === 'installed' && plugin) {
        asset = isCurrentContent(plugin, reference.contentHash)
          ? isFont
            ? await readPluginFontSlot(plugin.rootDir, plugin.manifest, reference.slot)
            : await readInstalledImage(plugin, reference.contentHash, reference.slot)
          : null
      }
      if (!asset) {
        return new Response(null, { status: 404 })
      }
      const isSvg = asset.mimeType === 'image/svg+xml'
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(asset.bytes), {
        headers: {
          'Content-Type': isSvg ? 'image/svg+xml; charset=utf-8' : asset.mimeType,
          'Content-Length': String(asset.bytes.byteLength),
          // Why immutable is safe: a hash or install hash names exact bytes; dev trees change in place.
          'Cache-Control':
            reference?.kind === 'installed' && reference.contentHash === 'dev'
              ? 'no-store'
              : 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          ...(isSvg
            ? {
                'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
              }
            : {}),
          // Why: web fonts and CSS masks load in CORS mode; only the default session handles this
          // scheme, so plugin frames and browser tabs, which use their own sessions, still cannot.
          ...(isFont || isPanelIcon ? { 'Access-Control-Allow-Origin': '*' } : {})
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
