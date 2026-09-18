import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
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
  ROUTE_SOURCE_LOADERS,
  assertRoutesCarryNoSynchronousExports,
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
    // esbuild's `[hash]` is over the metafile's input keys, which are paths relative to
    // absWorkingDir, so this name is not a function of the bytes and differs between two
    // checkouts of one commit. It is a placeholder: renameOutputsByContent replaces it below.
    chunkNames: '[hash]',
    // Pinned rather than defaulted, so the entry is found by name and not by elimination.
    entryNames: ENTRY_CHUNK_NAME,
    target: ['es2022'],
    charset: 'utf8',
    legalComments: 'none',
    // No sourcemap: it is an emitted file and would carry this checkout's absolute paths into the
    // bundle. The metafile carries them too but is never written and never hashed; it is the only
    // thing that says which output is the entry, which of its imports are static, and which
    // outputs each one names.
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
      ...ROUTE_SOURCE_LOADERS,
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

/**
 * Every emitted output, renamed to the sha256 of its own final bytes.
 *
 * esbuild's `[hash]` is computed over the metafile's input keys, and those keys are paths
 * relative to absWorkingDir. A tree whose mobile/node_modules is a symlink keys most of its
 * inputs as `../../<somewhere>/...`, a tree that holds a real directory keys them as
 * `node_modules/...`, and a byte-identical chunk comes out under a different name in each. The
 * name is embedded in every importer, so the difference cascades into a different buildId for one
 * commit -- and every phone re-downloads a bundle whose bytes never changed.
 *
 * Renaming here is what removes the path from the output. Leaves first, so an importer is hashed
 * only once the names written inside it are final: an image before the chunk that loads it, a
 * chunk before the chunk that imports it, the entry last. The result is what `hashedAsset` would
 * name each of these anyway, which is how the name inside the bytes and the manifest's own sha256
 * stay the same string.
 */
export function renameOutputsByContent(metafile, outputFiles) {
  const emitted = new Map(
    outputFiles.map((file) => [basename(file.path), Buffer.from(file.contents)])
  )
  const importsOf = new Map(
    Object.entries(metafile.outputs).map(([output, { imports }]) => [
      basename(output),
      (imports ?? []).map((entry) => basename(entry.path)).filter((name) => emitted.has(name))
    ])
  )
  const renamed = new Map()
  const open = new Set()
  function rename(name) {
    const done = renamed.get(name)
    if (done) {
      return done
    }
    if (open.has(name)) {
      // Two outputs naming each other have no content hash at all, so this is a hard stop rather
      // than a fallback. esbuild's splitting emits a DAG; nothing in the tree has produced one.
      throw new Error(
        `[build-mobile-web-app-bundle] ${name} is in an output cycle and cannot be content-named`
      )
    }
    open.add(name)
    let bytes = emitted.get(name)
    for (const child of importsOf.get(name) ?? []) {
      const { name: childName } = rename(child)
      // publicPath already rewrote the specifier to this exact shape, and an esbuild output name
      // is a token that appears nowhere else.
      bytes = Buffer.from(
        bytes.toString('utf8').split(`/assets/${child}`).join(`/assets/${childName}`),
        'utf8'
      )
    }
    open.delete(name)
    const result = { name: `${sha256Hex(bytes)}${extname(name)}`, bytes }
    renamed.set(name, result)
    return result
  }
  for (const name of [...emitted.keys()].sort()) {
    rename(name)
  }
  return renamed
}

/**
 * Which emitted chunk each route key's `import()` lands in. esbuild puts a route module in exactly
 * one output, so the metafile's own inputs answer it; nothing downstream can, because by then
 * every name is a hash of bytes and the route's source path is gone from the bundle.
 */
export function routeChunkNames(metafile, routes, renamed) {
  const owner = new Map()
  for (const [output, { inputs }] of Object.entries(metafile.outputs)) {
    for (const input of Object.keys(inputs ?? {})) {
      // Absolute, and through realpath on the lookup side below: esbuild writes its input keys
      // relative to absWorkingDir after resolving symlinks, so a route reached through one (every
      // scratch tree under /var on macOS) is keyed by a path the caller never spelled.
      owner.set(resolve(mobileDir, input), basename(output))
    }
  }
  return Object.fromEntries(
    routes.map(({ key, module }) => {
      const emittedName = owner.get(realpathSync(module))
      if (!emittedName) {
        throw new Error(`[build-mobile-web-app-bundle] ${key} reached no output`)
      }
      return [key, renamed.get(emittedName).name]
    })
  )
}

const isScriptOutput = (path) => path.endsWith('.js')

// appDir is a seam for the tests, which bundle a scratch route tree; production always uses mobile/app.
export async function bundleMobileWebApp({ appDir = defaultAppDir } = {}) {
  const routes = await collectMobileWebAppRoutes(appDir)
  await assertRoutesCarryNoSynchronousExports(routes)
  const result = await esbuild.build(mobileWebAppBuildOptions(routes))
  const entryOutputPath = Object.keys(result.metafile.outputs).find(
    (path) => basename(path) === `${ENTRY_CHUNK_NAME}.js`
  )
  if (!entryOutputPath) {
    throw new Error('[build-mobile-web-app-bundle] esbuild emitted no entry script')
  }
  const renamed = renameOutputsByContent(result.metafile, result.outputFiles)
  const entry = renamed.get(basename(entryOutputPath))
  const byName = (left, right) => (left.name < right.name ? -1 : 1)
  const others = [...renamed.entries()]
    .filter(([emittedName]) => emittedName !== basename(entryOutputPath))
    .map(([emittedName, output]) => ({ emittedName, ...output }))
  // Chunks keep their new name into the served path: the entry imports them by it, and
  // publicPath has already made that specifier /assets/<name>.
  const chunks = others.filter(({ emittedName }) => isScriptOutput(emittedName)).sort(byName)
  const images = others.filter(({ emittedName }) => !isScriptOutput(emittedName)).sort(byName)
  const closure = entryStaticClosure(result.metafile, entryOutputPath)
  return {
    script: entry.bytes,
    chunks,
    images,
    // Counted off the renamed bytes rather than the metafile's own sizes, which are from before
    // the names inside each output grew. Only the metafile knows which import is static; see
    // entryStaticClosure.
    entryStaticBytes: [...closure].reduce(
      (total, path) => total + (renamed.get(basename(path))?.bytes.byteLength ?? 0),
      0
    ),
    routeKeys: routes.map((route) => route.key),
    routeChunks: routeChunkNames(result.metafile, routes, renamed)
  }
}

export async function buildMobileWebAppBundle({ appDir, outDir = defaultOutDir } = {}) {
  const [
    desktopVersion,
    protocolWindow,
    { script, chunks, images, entryStaticBytes, routeChunks, routeKeys }
  ] = await Promise.all([
    readDesktopVersion(),
    readProtocolWindow(),
    bundleMobileWebApp({ appDir })
  ])
  // Every output is already named by its own bytes, and a name is written inside whatever imports
  // it, so hashedAsset here reproduces the name rather than choosing one.
  const scriptAsset = hashedAsset(script, 'js')
  const written = [
    scriptAsset,
    ...[...chunks, ...images].map(({ name, bytes }) => hashedAsset(bytes, extname(name).slice(1)))
  ]

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
    written: [indexAsset, ...written],
    desktopVersion,
    protocolWindow
  })
  return {
    manifest,
    outDir,
    routeChunks,
    routeKeys,
    entryStaticBytes,
    // The entry counts: it is a chunk the browser fetches, and the budget is about how many.
    chunkCount: chunks.length + 1,
    // Everything the routes import that is not a script, which is the rest of the asset budget.
    imageCount: images.length
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  try {
    const { manifest, outDir, routeKeys, entryStaticBytes, chunkCount } =
      await buildMobileWebAppBundle()
    console.log(
      `[build-mobile-web-app-bundle] OK — ${String(routeKeys.length)} route(s), ` +
        `${String(chunkCount)} chunk(s), ${String(entryStaticBytes)} bytes before the first route, ` +
        `${String(manifest.assets.length)} asset(s), ${String(manifest.totalBytes)} bytes, ` +
        `buildId ${manifest.buildId} -> ${outDir}`
    )
  } catch (error) {
    // The route guards fail here by design, and every throw on this path already names its
    // source, so a stack only buries which route and which export.
    console.error(error.message)
    process.exit(1)
  }
}
