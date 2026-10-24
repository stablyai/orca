import { protocol } from 'electron'
import { PLUGIN_IMAGE_MIME, readPluginImageHeader } from '../../shared/plugins/plugin-image-format'
import { PLUGIN_IMAGE_RULES, pluginImageRuleError } from '../../shared/plugins/plugin-image-fields'
import { PLUGIN_IMAGE_SCHEME, parsePluginImageUrl } from '../../shared/plugins/plugin-image-url'
import { readContainedPluginArtifactBytes } from './plugin-artifact-validation'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { declaredPluginImages } from './plugin-image-artifact-validation'
import type { PluginImageCache } from './plugin-image-cache'

export type PluginImageProtocolDependencies = {
  cache: PluginImageCache
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
}

type ServedImage = { bytes: Buffer; mimeType: string }

/** An installed plugin's declared image, re-checked on every read like at install. */
async function readInstalledImage(
  plugin: ValidDiscoveredPlugin,
  contentHash: string,
  slot: string
): Promise<ServedImage | null> {
  if (contentHash !== (plugin.isDev ? 'dev' : plugin.contentHash)) {
    return null
  }
  const images = declaredPluginImages(plugin.manifest)
  const screenshot = /^screenshot-(\d+)$/.exec(slot)
  const image = screenshot
    ? images.filter((candidate) => candidate.kind === 'screenshot')[Number(screenshot[1])]
    : images.find((candidate) => candidate.kind === slot)
  if (!image) {
    return null
  }
  const bytes = await readContainedPluginArtifactBytes(
    plugin.rootDir,
    image.path,
    PLUGIN_IMAGE_RULES[image.kind].maxBytes
  )
  const info = readPluginImageHeader(bytes)
  if (typeof info === 'string' || pluginImageRuleError(image.kind, info, bytes.byteLength)) {
    return null
  }
  return { bytes, mimeType: PLUGIN_IMAGE_MIME[info.format] }
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
      let image: ServedImage | null = null
      if (reference?.kind === 'sha') {
        image = await dependencies.cache.get(reference.sha256)
      } else if (reference?.kind === 'installed') {
        const plugin = dependencies.findValidPlugin(reference.pluginKey)
        image = plugin
          ? await readInstalledImage(plugin, reference.contentHash, reference.slot)
          : null
      }
      if (!image) {
        return new Response(null, { status: 404 })
      }
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(image.bytes), {
        headers: {
          'Content-Type': image.mimeType,
          'Content-Length': String(image.bytes.byteLength),
          // Why immutable is safe: every URL names exact bytes (a hash or an install hash).
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff'
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
