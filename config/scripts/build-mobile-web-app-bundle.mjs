import { readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import {
  MOBILE_WEB_BUNDLE_ENTRYPOINT,
  hashedAsset,
  isDirectInvocation,
  readDesktopVersion,
  readProtocolWindow,
  sha256Hex,
  writeMobileWebBundleTree,
  contentTypeForExtension
} from './build-mobile-web-bundle.mjs'
import {
  collectMobileWebAppRoutes,
  renderMobileWebAppRouteManifest
} from './mobile-web-app-route-manifest.mjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const mobileDir = join(projectDir, 'mobile')
const defaultAppDir = join(mobileDir, 'app')
const entryPoint = join(mobileDir, 'web-entry', 'index.tsx')
const defaultOutDir = join(projectDir, 'out', 'mobile-web-app')

/**
 * Every shim the app bundle needs, each one a documented Metro/RN-Web gap. `appliesTo` reads the
 * esbuild option that implements the shim, so the list cannot claim a shim the build does not
 * apply and a dropped option fails the named shim rather than the whole build.
 */
export const MOBILE_WEB_APP_SHIMS = [
  {
    // react-native has no browser build; react-native-web is the whole point of Route A.
    name: 'react-native-web-alias',
    appliesTo: (options) => options.alias?.['react-native'] === 'react-native-web'
  },
  {
    // RN ships untranspiled JSX inside .js files (expo-router's own build/ included).
    name: 'js-as-jsx',
    appliesTo: (options) => options.loader?.['.js'] === 'jsx'
  },
  {
    // RN code assumes a Hermes/Metro `global`; the browser only has `globalThis`.
    name: 'global-as-globalthis',
    appliesTo: (options) => options.define?.global === 'globalThis'
  },
  {
    // RN and Expo modules read process.env at module scope, before any of our code runs.
    name: 'process-banner',
    appliesTo: (options) => options.banner?.js?.includes('globalThis.process ??=') === true
  },
  {
    // lucide-react-native@1.14.0's barrel re-exports LucideProvider from a context.mjs that does
    // not export it. Metro's loose CJS interop tolerates it; esbuild's strict ESM does not.
    // Web-build only: patching the package would change what the shipped native app consumes.
    name: 'lucide-barrel-provider',
    appliesTo: (options) =>
      options.plugins?.some((plugin) => plugin.name === LUCIDE_PLUGIN_NAME) === true
  },
  {
    // esbuild has no require.context, so the route tree is generated and injected.
    name: 'route-manifest',
    appliesTo: (options) =>
      options.plugins?.some((plugin) => plugin.name === ROUTE_MANIFEST_PLUGIN_NAME) === true
  }
]

const ROUTE_MANIFEST_PLUGIN_NAME = 'orca-route-manifest'
const LUCIDE_PLUGIN_NAME = 'orca-lucide-barrel-provider'

/** The entry output's name, so classifying the outputs never has to guess which one it is. */
const ENTRY_CHUNK_NAME = 'entry'

// mobile/web-entry/route-manifest.ts is a real typed file rather than a virtual specifier, so the
// entry typechecks and Metro can still resolve it; only its body is replaced here.
function routeManifestPlugin(manifestSource) {
  return {
    name: ROUTE_MANIFEST_PLUGIN_NAME,
    setup(build) {
      build.onLoad({ filter: /web-entry[\\/]route-manifest\.ts$/ }, () => ({
        contents: manifestSource,
        loader: 'js',
        resolveDir: mobileDir
      }))
    }
  }
}

const lucideBarrelPlugin = {
  name: LUCIDE_PLUGIN_NAME,
  setup(build) {
    build.onLoad({ filter: /lucide-react-native[\\/].*[\\/]context\.mjs$/ }, async (args) => ({
      contents: `${await readFile(args.path, 'utf8')}\nexport const LucideProvider = ({ children }) => children;\n`,
      loader: 'js'
    }))
  }
}

/** Split out so a test can read the options MOBILE_WEB_APP_SHIMS claims, without a build. */
export function mobileWebAppBuildOptions(routes) {
  return {
    // Fixed so no absolute path of this checkout can reach the output.
    absWorkingDir: mobileDir,
    entryPoints: [entryPoint],
    bundle: true,
    minify: true,
    // Virtual: write is false, so outdir only names the emitted files esbuild hands back.
    outdir: 'dist',
    write: false,
    // esm, because `splitting` requires it and a per-route chunk is the point: with iife and
    // static imports esbuild emitted one 8.16 MB script for all 14 routes.
    format: 'esm',
    splitting: true,
    // Content-hashed, like the images, so a chunk's name survives into the served path unchanged
    // and the buildId stays a pure function of the bytes.
    chunkNames: '[hash]',
    // Pinned rather than defaulted, so the entry is found by name and not by elimination.
    entryNames: ENTRY_CHUNK_NAME,
    target: ['es2022'],
    charset: 'utf8',
    legalComments: 'none',
    // No sourcemap: it is an emitted file and would carry this checkout's absolute paths into the
    // bundle. The metafile carries them too but is never written and never hashed; it is the only
    // thing that says which output is the entry and which of its imports are static.
    sourcemap: false,
    metafile: true,
    logLevel: 'silent',
    jsx: 'automatic',
    // One React: resolve everything from mobile/node_modules, which is where the entry lives.
    nodePaths: [join(mobileDir, 'node_modules')],
    alias: { 'react-native': 'react-native-web' },
    plugins: [routeManifestPlugin(renderMobileWebAppRouteManifest(routes)), lucideBarrelPlugin],
    resolveExtensions: [
      '.web.tsx',
      '.web.ts',
      '.web.jsx',
      '.web.js',
      '.tsx',
      '.ts',
      '.jsx',
      '.js',
      '.json'
    ],
    // Images are emitted as same-origin assets, not data: URLs: the shell's CSP sets
    // img-src 'self', which refuses data:. Content-hashed names keep the buildId reproducible.
    // A font would fail the build here rather than silently ship under font-src 'none'.
    loader: {
      '.js': 'jsx',
      '.png': 'file',
      '.jpg': 'file',
      '.jpeg': 'file',
      '.gif': 'file',
      '.webp': 'file',
      '.svg': 'file'
    },
    assetNames: '[hash]',
    // Absolute, because the document is served at every route depth and a path relative to the
    // script would resolve against the route instead.
    publicPath: '/assets',
    banner: {
      js: "globalThis.process ??= { env: { NODE_ENV: 'production', EXPO_OS: 'web' }, platform: 'web', version: '', nextTick: (fn) => setTimeout(fn, 0) };"
    },
    define: {
      global: 'globalThis',
      __DEV__: 'false',
      'process.env.NODE_ENV': '"production"',
      'process.env.EXPO_OS': '"web"',
      'process.env.EXPO_ROUTER_IMPORT_MODE': '"sync"'
    }
  }
}

/**
 * What the browser must have before the first route can paint: the entry plus every chunk it
 * reaches by static import, transitively. A dynamic import is what the split exists to defer, so
 * it is where this stops.
 *
 * The bound the verifier holds is this number and not the entry file alone, because esbuild puts
 * the code shared by entry and routes in a chunk the entry imports statically: budgeting the entry
 * file on its own would fall as the shared chunk grew.
 */
export function entryStaticClosure(metafile, entryOutputPath) {
  const reached = new Set([entryOutputPath])
  const queue = [entryOutputPath]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const imported of metafile.outputs[current]?.imports ?? []) {
      if (imported.kind !== 'import-statement' || reached.has(imported.path)) {
        continue
      }
      reached.add(imported.path)
      queue.push(imported.path)
    }
  }
  return reached
}

const isScriptOutput = (path) => path.endsWith('.js')

// appDir is a seam for the tests, which bundle a scratch route tree; production always uses mobile/app.
export async function bundleMobileWebApp({ appDir = defaultAppDir } = {}) {
  const routes = await collectMobileWebAppRoutes(appDir)
  const result = await esbuild.build(mobileWebAppBuildOptions(routes))
  const entryOutputPath = Object.keys(result.metafile.outputs).find(
    (path) => basename(path) === `${ENTRY_CHUNK_NAME}.js`
  )
  const entryFile = result.outputFiles.find(
    (file) => basename(file.path) === `${ENTRY_CHUNK_NAME}.js`
  )
  if (!entryOutputPath || !entryFile) {
    throw new Error('[build-mobile-web-app-bundle] esbuild emitted no entry script')
  }
  const named = (file) => ({ name: basename(file.path), bytes: Buffer.from(file.contents) })
  const byName = (left, right) => (left.name < right.name ? -1 : 1)
  const others = result.outputFiles.filter((file) => file !== entryFile)
  // Chunks keep esbuild's own names: the entry imports them by that name, and publicPath has
  // already rewritten those specifiers to /assets/<name>.
  const chunks = others
    .filter((file) => isScriptOutput(file.path))
    .map(named)
    .sort(byName)
  const images = others
    .filter((file) => !isScriptOutput(file.path))
    .map(named)
    .sort(byName)
  const closure = entryStaticClosure(result.metafile, entryOutputPath)
  return {
    script: Buffer.from(entryFile.contents),
    chunks,
    images,
    // Counted here because only the metafile knows which import is static; see entryStaticClosure.
    entryStaticBytes: [...closure].reduce(
      (total, path) => total + (result.metafile.outputs[path]?.bytes ?? 0),
      0
    ),
    routeKeys: routes.map((route) => route.key)
  }
}

export async function buildMobileWebAppBundle({ outDir = defaultOutDir } = {}) {
  const [desktopVersion, protocolWindow, { script, chunks, images, entryStaticBytes, routeKeys }] =
    await Promise.all([readDesktopVersion(), readProtocolWindow(), bundleMobileWebApp()])
  // Only the entry is renamed: nothing references it but the document. A chunk is named inside
  // the bytes that import it, so renaming one would break the import it is named by.
  const scriptAsset = hashedAsset(script, 'js')
  // esbuild already named these by content hash; keep that name so the reference inside the
  // script stays valid, and carry the sha256 in the manifest entry as every asset does.
  const emittedAssets = [...chunks, ...images].map(({ name, bytes }) => ({
    bytes,
    path: `assets/${name}`,
    sha256: sha256Hex(bytes),
    byteLength: bytes.byteLength,
    contentType: contentTypeForExtension(extname(name).slice(1))
  }))

  // Root-absolute, unlike the Phase A bootstrap's bare relative src: this document is served at
  // every route depth (/h/<hostId>/tasks), where a relative href resolves against the route and
  // 404s. A <base> tag would be the other fix, but the shell's CSP sets base-uri 'none'.
  // type="module", because the entry is esm and reaches its routes through import(). Same-origin
  // module and chunk both load under the shell's script-src 'self'; the policy is unchanged.
  const html =
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n' +
    '<title>Orca</title>\n</head>\n<body>\n<div id="root"></div>\n' +
    `<script type="module" src="/${scriptAsset.path}"></script>\n</body>\n</html>\n`
  const indexBytes = Buffer.from(html, 'utf8')
  const indexAsset = {
    bytes: indexBytes,
    path: MOBILE_WEB_BUNDLE_ENTRYPOINT,
    sha256: sha256Hex(indexBytes),
    byteLength: indexBytes.byteLength,
    contentType: contentTypeForExtension('html')
  }

  const { manifest } = await writeMobileWebBundleTree({
    outDir,
    written: [indexAsset, scriptAsset, ...emittedAssets],
    desktopVersion,
    protocolWindow
  })
  return {
    manifest,
    outDir,
    routeKeys,
    entryStaticBytes,
    // The entry counts: it is a chunk the browser fetches, and the budget is about how many.
    chunkCount: chunks.length + 1
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const { manifest, outDir, routeKeys, entryStaticBytes, chunkCount } =
    await buildMobileWebAppBundle()
  console.log(
    `[build-mobile-web-app-bundle] OK — ${String(routeKeys.length)} route(s), ` +
      `${String(chunkCount)} chunk(s), ${String(entryStaticBytes)} bytes before the first route, ` +
      `${String(manifest.assets.length)} asset(s), ${String(manifest.totalBytes)} bytes, ` +
      `buildId ${manifest.buildId} -> ${outDir}`
  )
}
