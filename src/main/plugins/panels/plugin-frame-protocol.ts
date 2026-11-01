import { stat } from 'node:fs/promises'
import {
  parsePluginFrameUrl,
  PLUGIN_DECLARATIVE_HOST_FILE,
  PLUGIN_DECLARATIVE_RUNTIME_FILE
} from '../../../shared/plugins/frames/plugin-frame-guest'
import { buildPluginDeclarativeHostBody } from '../../../shared/plugins/frames/plugin-declarative-host-document'
import {
  buildPluginGuestShellHtml,
  type PluginFrameSurface
} from '../../../shared/plugins/frames/plugin-panel-shell'
import type { PluginFrameTheme } from '../../../shared/plugins/frames/plugin-frame-bridge'
import { isPluginSourceModulePath } from '../../../shared/plugins/frames/plugin-frame-source-modules'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import {
  readContainedPluginArtifactBytes,
  resolveContainedPluginArtifact
} from '../plugin-artifact-validation'
import {
  createPluginFrameIntegrity,
  matchesVerifiedDigest,
  verifyPluginFrameTree,
  type PluginFrameTreeVerifier
} from './plugin-frame-integrity'
import {
  bufferedResponse,
  busy,
  HTML_CONTENT_TYPE,
  isCheckedPluginFrameType,
  JAVASCRIPT_CONTENT_TYPE,
  notFound,
  pluginFrameContentType,
  streamedResponse
} from './plugin-frame-responses'
import {
  createPluginSourceModuleCompiler,
  PLUGIN_SOURCE_MODULE_MAX_BYTES,
  type PluginSourceModuleCompiler
} from './plugin-frame-module-transform'
import {
  pluginFileExistsIn,
  pluginSourceModuleDocumentBody,
  PLUGIN_SOURCE_MODULE_QUERY
} from './plugin-frame-source-serving'

export { pluginFrameContentType } from './plugin-frame-responses'

/** Streamed assets (images, fonts, media); the whole plugin tree is capped at 50 MiB anyway. */
export const PLUGIN_FRAME_ASSET_MAX_BYTES = 32 * 1024 * 1024
/** Documents, scripts and WASM are read whole to check their digest, so they get a lower cap. */
export const PLUGIN_FRAME_CHECKED_MAX_BYTES = 16 * 1024 * 1024
/** Concurrent requests one guest session may hold open; more get 503 until some finish. */
export const PLUGIN_FRAME_MAX_IN_FLIGHT = 32

export type PluginFrameProtocolDependencies = {
  /** Installed, enabled and consented plugins only. */
  findApprovedPluginByFrameKey: (frameKey: string) => ValidDiscoveredPlugin | null
  /** Defaults to hashing the tree with per-file digests (plugin-frame-integrity.ts). */
  verifyTree?: PluginFrameTreeVerifier
  log?: (pluginKey: string, line: string) => void
  now?: () => number
  /** The host's current theme, baked into each document so the first paint matches. */
  currentTheme?: () => PluginFrameTheme | null
  /** Bytes of resources/plugins/declarative/orca-runtime.mjs, the guest `orca` module. */
  readDeclarativeRuntime?: () => Promise<Uint8Array>
  /** Transpiles `.ts/.tsx/.mts/.jsx`; shared across sessions so its cache is too. */
  compileSourceModule?: PluginSourceModuleCompiler
}

const defaultSourceModuleCompiler = createPluginSourceModuleCompiler()

// Why: on these file systems `Editor.HTML` serves the same file as the declared `editor.html`.
const CASE_INSENSITIVE_PATHS = process.platform === 'darwin' || process.platform === 'win32'

const samePath = (a: string, b: string): boolean =>
  CASE_INSENSITIVE_PATHS ? a.toLowerCase() === b.toLowerCase() : a === b

/** A declared custom-editor entry gets the editor API; every other document is a panel. */
function documentSurface(plugin: ValidDiscoveredPlugin, relativePath: string): PluginFrameSurface {
  return plugin.manifest.contributes.customEditors.some((editor) =>
    samePath(editor.entry, relativePath)
  )
    ? 'editor'
    : 'panel'
}

/** A declared HTML entry is a document whatever its extension (`dist/panel` included). */
function isDeclaredFrameEntry(plugin: ValidDiscoveredPlugin, relativePath: string): boolean {
  const { panels, customEditors } = plugin.manifest.contributes
  return (
    customEditors.some((editor) => samePath(editor.entry, relativePath)) ||
    panels.some((panel) => panel.ui !== 'components' && samePath(panel.entry, relativePath))
  )
}

/**
 * Serves `orca-plugin-frame://<key>/<path>` from the plugin root with the same containment and
 * content-integrity checks as panel entries. Anything else, including `__orca/`, is 404.
 */
export function createPluginFrameRequestHandler(
  dependencies: PluginFrameProtocolDependencies,
  /** The partition's key: a session only ever serves its own plugin. */
  sessionFrameKey: string
): (request: Request) => Promise<Response> {
  const now = dependencies.now ?? (() => Date.now())
  const integrity = createPluginFrameIntegrity(
    dependencies.verifyTree ?? verifyPluginFrameTree,
    now
  )
  let inFlight = 0
  const serve = async (request: Request, stream: () => () => void): Promise<Response> => {
    const target = parsePluginFrameUrl(request.url)
    if (!target || target.frameKey !== sessionFrameKey) {
      return notFound()
    }
    const plugin = dependencies.findApprovedPluginByFrameKey(target.frameKey)
    if (!plugin) {
      return notFound()
    }
    if (target.reserved) {
      const body = await readOrcaFile(dependencies, plugin, target.segments, request.url)
      return body ? bufferedResponse(request, body.contentType, body.bytes) : notFound()
    }
    const relativePath = target.segments.join('/')
    const isSourceModule = isPluginSourceModulePath(relativePath)
    // Why a query, not request headers: guest navigations reach the handler without sec-fetch-*.
    const isDocument =
      isDeclaredFrameEntry(plugin, relativePath) &&
      (!isSourceModule || !new URL(request.url).searchParams.has(PLUGIN_SOURCE_MODULE_QUERY))
    const contentType = isDocument
      ? HTML_CONTENT_TYPE
      : isSourceModule
        ? JAVASCRIPT_CONTENT_TYPE
        : pluginFrameContentType(relativePath)
    try {
      // Why: a navigation re-verifies like a panel entry; a fetch of an .html file is an asset
      // and rides the last check, so it cannot force a whole-tree re-hash per request.
      const digests = await integrity(plugin, isNavigationRequest(request))
      if (!isDocument && !isCheckedPluginFrameType(contentType)) {
        const path = await resolveContainedPluginArtifact(
          plugin.rootDir,
          relativePath,
          PLUGIN_FRAME_ASSET_MAX_BYTES
        )
        const { size } = await stat(path)
        return streamedResponse(request, path, size, contentType, stream())
      }
      const bytes = await readContainedPluginArtifactBytes(
        plugin.rootDir,
        relativePath,
        isSourceModule && !isDocument
          ? PLUGIN_SOURCE_MODULE_MAX_BYTES
          : PLUGIN_FRAME_CHECKED_MAX_BYTES
      )
      // Why per file: the tree check ran before this read; these must be the bytes it covered.
      if (!matchesVerifiedDigest(digests, relativePath, bytes)) {
        throw new Error('changed since the plugin tree was verified')
      }
      if (isSourceModule && !isDocument) {
        const compile = dependencies.compileSourceModule ?? defaultSourceModuleCompiler
        const code = await compile({
          relativePath,
          bytes,
          exists: pluginFileExistsIn(plugin.rootDir, digests)
        })
        return bufferedResponse(request, contentType, Buffer.from(code, 'utf8'))
      }
      const body = contentType.startsWith('text/html')
        ? Buffer.from(
            buildPluginGuestShellHtml(
              isSourceModule
                ? pluginSourceModuleDocumentBody(relativePath)
                : bytes.toString('utf8'),
              documentSurface(plugin, relativePath),
              {
                theme: dependencies.currentTheme?.()
              }
            ),
            'utf8'
          )
        : bytes
      return bufferedResponse(request, contentType, body)
    } catch (error) {
      // A missing file is an ordinary 404; only refusals are worth the plugin's log.
      if (!isMissingFileError(error)) {
        dependencies.log?.(
          plugin.pluginKey,
          `frame asset ${relativePath} rejected: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return notFound()
    }
  }
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 })
    }
    // Why a cap: each request may hold a file in memory or an open stream until it completes.
    if (inFlight >= PLUGIN_FRAME_MAX_IN_FLIGHT) {
      return busy()
    }
    inFlight += 1
    let released = false
    const release = (): void => {
      if (!released) {
        released = true
        inFlight -= 1
      }
    }
    // A streamed body releases its slot when it ends; everything else is done once answered.
    let streaming = false
    try {
      return await serve(request, () => {
        streaming = true
        return release
      })
    } finally {
      if (!streaming) {
        release()
      }
    }
  }
}

/** `__orca/*`: only files Orca ships, never the plugin's own files under that name. */
async function readOrcaFile(
  dependencies: PluginFrameProtocolDependencies,
  plugin: ValidDiscoveredPlugin,
  segments: readonly string[],
  url: string
): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  const file = segments.length === 2 ? segments[1] : null
  if (file === PLUGIN_DECLARATIVE_RUNTIME_FILE) {
    const bytes = await dependencies.readDeclarativeRuntime?.().catch(() => null)
    return bytes ? { contentType: pluginFrameContentType(file), bytes } : null
  }
  if (file !== PLUGIN_DECLARATIVE_HOST_FILE) {
    return null
  }
  // Why from the manifest: the page imports a declared declarative entry, never a caller's path.
  const entry = new URL(url).searchParams.get('entry')
  const declared = plugin.manifest.contributes.panels.some(
    (panel) => panel.ui === 'components' && panel.entry === entry
  )
  if (!entry || !declared) {
    return null
  }
  const html = buildPluginGuestShellHtml(buildPluginDeclarativeHostBody(entry), 'panel', {
    declarative: true,
    theme: dependencies.currentTheme?.()
  })
  return { contentType: pluginFrameContentType(file), bytes: Buffer.from(html, 'utf8') }
}

function isNavigationRequest(request: Request): boolean {
  const destination = request.headers.get('sec-fetch-dest')
  return (
    request.headers.get('sec-fetch-mode') === 'navigate' ||
    destination === 'document' ||
    destination === 'iframe'
  )
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
