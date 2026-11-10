import { readFile, readdir } from 'node:fs/promises'
import { readRouteSnapshot } from '../../mobile-web-app/mobile-web-app-route-snapshot.mjs'
import { MOBILE_WEB_APP_DEPENDENCY_PATH } from '../../mobile-web-app/mobile-web-app-bundle-dependencies.mjs'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import {
  MOBILE_WEB_BUNDLE_ENTRYPOINT,
  hashedAsset,
  readDesktopVersion,
  readProtocolWindow,
  sha256Hex,
  writeMobileWebBundleTree,
  contentTypeForExtension
} from './mobile-web-bundle-manifest.mjs'
import { isDirectInvocation } from '../../tool-invocation/script-entry-detection.mjs'
import {
  ROUTE_SOURCE_LOADERS,
  assertRoutesCarryNoSynchronousExports,
  collectMobileWebAppRoutes,
  renderMobileWebAppRouteManifest,
  routePathnameFromKey
} from '../../mobile-web-app/mobile-web-app-route-manifest.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'
import {
  ROUTE_ENTRY_NAMESPACE,
  entryStaticClosure,
  isScriptOutput,
  lazyModulesToAnchor,
  sharedModulesToMerge
} from './mobile-web-app-chunk-grouping.mjs'

const projectDir = fileURLToPath(new URL('../../../..', import.meta.url))
const mobileDir = join(projectDir, 'mobile')
const defaultAppDir = join(mobileDir, 'app')
const entryPoint = join(mobileDir, 'web-entry', 'index.tsx')
// Use packager guard’s output directory or independent constants can drift into missing packaged bundles.
const { MOBILE_WEB_BUNDLE_DIR: defaultOutDir } = createRequire(import.meta.url)(
  '../../desktop-distribution/runtime-verification/verify-packaged-mobile-web-bundle.cjs'
)
// The desktop serves this page, so a dark switch the desktop was built with reaches it too.
const { turnedOnDarkBuildDefines } = createRequire(import.meta.url)(
  '../../../dark-build-switches.cjs'
)

// Tie each Metro/RN-Web shim to the option implementing it so missing options fail with the shim’s name.
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
    // Set jitless before module-scope schemas probe new Function, which otherwise emits CSP violations even when caught.
    name: 'zod-jitless-banner',
    appliesTo: (options) => options.banner?.js?.includes('__zod_globalConfig') === true
  },
  {
    // Alias all shared/mobile modules to mobile’s Zod, matching tsconfig and keeping salvage leaves in the container’s instance.
    name: 'one-zod',
    appliesTo: (options) => options.alias?.zod === MOBILE_ZOD_PACKAGE
  },
  {
    // lucide-react-native@1.14.0 reexports missing LucideProvider; esbuild rejects what Metro tolerates. Patch only web build, preserving native package.
    name: 'lucide-barrel-provider',
    appliesTo: (options) =>
      options.plugins?.some((plugin) => plugin.name === LUCIDE_PLUGIN_NAME) === true
  },
  {
    // Shell has no durable localStorage (Android disabled, iOS session origin changes); bridge init/storage grant persists page-owned values.
    name: 'async-storage-over-the-bridge',
    appliesTo: (options) =>
      options.alias?.['@react-native-async-storage/async-storage'] === PAGE_ASYNC_STORAGE_MODULE
  },
  {
    // RN-Web hairline is 1 CSS px; native paints one device pixel.
    name: 'hairline-device-pixel',
    appliesTo: (options) =>
      options.plugins?.some((plugin) => plugin.name === HAIRLINE_PLUGIN_NAME) === true
  },
  {
    // esbuild has no require.context, so the route tree is generated and injected.
    name: 'route-manifest',
    appliesTo: (options) =>
      options.plugins?.some((plugin) => plugin.name === ROUTE_MANIFEST_PLUGIN_NAME) === true
  }
]

// Match Expo root reset/id: definite html/body/root heights prevent silent zero-height lists with accessible but untappable rows.
// Inline under existing unsafe-inline style CSP to avoid a collapsed first frame; RN-Web owns body margin reset.
export const MOBILE_WEB_APP_ROOT_RESET =
  '<style id="expo-reset">html,body{height:100%}body{overflow:hidden}' +
  '#root{display:flex;height:100%;flex:1}</style>'

// Use zero-specificity native parity: remove text-field focus rings only; keyboard buttons keep browser rings.
// Disable body text selection/callout to prevent WebKit/Android long-press interference, including portaled modals; fields opt back in.
// Stop the WebView rubber-banding the whole page (headers included) when an inner list hits its end; inner scrollers keep their bounce.
export const MOBILE_WEB_APP_NATIVE_PARITY_STYLE =
  '<style id="orca-native-parity">:where(input:focus,textarea:focus){outline:none}' +
  ':where(html){overscroll-behavior:none}' +
  ':where(body){-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
  ':where(input,textarea,[contenteditable]){-webkit-user-select:text;user-select:text;' +
  '-webkit-touch-callout:default}</style>'

const PAGE_ASYNC_STORAGE_MODULE = join(
  mobileDir,
  'src',
  'mobile-web-shell',
  'bridge',
  'page-async-storage.ts'
)

// nodePaths cannot override shared modules’ root Zod resolution. Alias mobile’s package to match tsconfig and salvage/container instances; esbuild picks its ESM module entry.
const MOBILE_ZOD_PACKAGE = join(mobileDir, 'node_modules', 'zod')

// Set __zod_globalConfig.jitless in banner: module-scope schema construction probes eval before our imports can configure it, generating caught-but-reported CSP violations.
const ZOD_JITLESS_BANNER =
  'globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;'

const ROUTE_MANIFEST_PLUGIN_NAME = 'orca-route-manifest'
const LUCIDE_PLUGIN_NAME = 'orca-lucide-barrel-provider'
const HAIRLINE_PLUGIN_NAME = 'orca-hairline-device-pixel'

const ENTRY_CHUNK_NAME = 'entry'

const ROUTE_MANIFEST_MODULE = /web-entry[\\/]route-manifest(\.ts)?$/
const LAZY_ENTRY_NAMESPACE = 'orca-lazy-entry'

// The entry's static imports as written, minus the manifest: a route importing it would be an output cycle.
async function entryImportAnchors() {
  const scan = await esbuild.build({
    entryPoints: [entryPoint],
    write: false,
    metafile: true,
    outdir: 'scan',
    logLevel: 'silent'
  })
  const [{ imports }] = Object.values(scan.metafile.outputs)
  return imports
    .filter(
      ({ kind, path }) =>
        kind === 'import-statement' && !ROUTE_MANIFEST_MODULE.test(join(dirname(entryPoint), path))
    )
    .map(({ path }) => `import ${JSON.stringify(path)}\n`)
    .join('')
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Keep typed route-manifest file for TS/Metro resolution; replace only its body for web.
// Routes import the entry's imports first, so esbuild keeps those modules in one chunk instead of one per route subset.
// Routes also import every module in sharedModules, which esbuild then puts in one chunk all routes load.
// Lazy modules in anchoredLazyModules (path to export names) get the same imports, so they don't split those chunks either.
function routeManifestPlugin(manifestSource, routes, sharedModules, anchoredLazyModules) {
  let anchors
  const anchoredImports = async () => {
    anchors ??= entryImportAnchors()
    const shared = sharedModules.map((module) => `import ${JSON.stringify(module)}\n`).join('')
    return `${await anchors}${shared}`
  }
  return {
    name: ROUTE_MANIFEST_PLUGIN_NAME,
    setup(build) {
      build.onLoad({ filter: ROUTE_MANIFEST_MODULE }, () => ({
        contents: manifestSource,
        loader: 'js',
        resolveDir: mobileDir
      }))
      if (routes.length > 0) {
        const routeImport = new RegExp(
          `^(?:${routes.map(({ module }) => escapeRegExp(module)).join('|')})$`
        )
        build.onResolve({ filter: routeImport }, (args) =>
          args.kind === 'dynamic-import'
            ? { path: args.path, namespace: ROUTE_ENTRY_NAMESPACE }
            : undefined
        )
        build.onLoad({ filter: /.*/, namespace: ROUTE_ENTRY_NAMESPACE }, async (args) => ({
          contents: `${await anchoredImports()}export { default } from ${JSON.stringify(args.path)}\n`,
          loader: 'js',
          resolveDir: dirname(entryPoint)
        }))
      }
      if (anchoredLazyModules.size === 0) {
        return
      }
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind !== 'dynamic-import' || args.pluginData === LAZY_ENTRY_NAMESPACE) {
          return undefined
        }
        const { path, errors } = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: LAZY_ENTRY_NAMESPACE
        })
        return errors.length === 0 && anchoredLazyModules.has(path)
          ? { path, namespace: LAZY_ENTRY_NAMESPACE }
          : undefined
      })
      build.onLoad({ filter: /.*/, namespace: LAZY_ENTRY_NAMESPACE }, async (args) => ({
        contents: `${await anchoredImports()}export { ${anchoredLazyModules.get(args.path).join(', ')} } from ${JSON.stringify(args.path)}\n`,
        loader: 'js',
        resolveDir: dirname(entryPoint)
      }))
    }
  }
}

// Reuse this shim in component render checks so icon builds match the page.
export const lucideBarrelPlugin = {
  name: LUCIDE_PLUGIN_NAME,
  setup(build) {
    build.onLoad({ filter: /lucide-react-native[\\/].*[\\/]context\.mjs$/ }, async (args) => ({
      contents: `${await readFile(args.path, 'utf8')}\nexport const LucideProvider = ({ children }) => children;\n`,
      loader: 'js'
    }))
  }
}

// react-native-web's own assignment, matched whole so an upgrade that moves it fails the build.
const RNW_HAIRLINE_ASSIGNMENT = 'StyleSheet.hairlineWidth = 1;'
// Round native hairline upward to 1/64 CSS px: WebKit floors exact 1/3 to 21/64 and paints nothing at 3×; 22/64 minimizes spill across rows.
const DEVICE_PIXEL_HAIRLINE_ASSIGNMENT =
  'StyleSheet.hairlineWidth = (function (ratio) {' +
  ' return Math.ceil((64 * (Math.round(0.4 * ratio) || 1)) / ratio) / 64; })' +
  "(typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);"

const hairlineDevicePixelPlugin = {
  name: HAIRLINE_PLUGIN_NAME,
  setup(build) {
    build.onLoad(
      // Both builds: once a dependency requires it, esbuild resolves every importer to cjs.
      { filter: /react-native-web[\\/]dist[\\/](cjs[\\/])?exports[\\/]StyleSheet[\\/]index\.js$/ },
      async (args) => {
        const source = await readFile(args.path, 'utf8')
        if (!source.includes(RNW_HAIRLINE_ASSIGNMENT)) {
          throw new Error(`${HAIRLINE_PLUGIN_NAME}: ${args.path} no longer assigns hairlineWidth`)
        }
        return {
          contents: source.replace(RNW_HAIRLINE_ASSIGNMENT, DEVICE_PIXEL_HAIRLINE_ASSIGNMENT),
          loader: 'js'
        }
      }
    )
  }
}

/** Split out so a test can read the options MOBILE_WEB_APP_SHIMS claims, without a build. */
export function mobileWebAppBuildOptions(
  routes,
  sharedModules = [],
  anchoredLazyModules = new Map()
) {
  return {
    // Fixed so no absolute path of this checkout can reach the output.
    absWorkingDir: mobileDir,
    entryPoints: [entryPoint],
    bundle: true,
    minify: true,
    // Virtual: write is false, so outdir only names the emitted files esbuild hands back.
    outdir: 'dist',
    write: false,
    // ESM splitting defers routes; IIFE/static imports emitted one 8.16MB script for 14 routes.
    format: 'esm',
    splitting: true,
    // esbuild hashes path-keyed inputs, not output bytes; renameOutputsByContent replaces checkout-dependent placeholders.
    chunkNames: '[hash]',
    // Pinned rather than defaulted, so the entry is found by name and not by elimination.
    entryNames: ENTRY_CHUNK_NAME,
    target: ['es2022'],
    charset: 'utf8',
    legalComments: 'none',
    // Omit maps carrying absolute checkout paths; keep unhashed/unwritten metafile for output/import classification.
    sourcemap: false,
    metafile: true,
    logLevel: 'silent',
    jsx: 'automatic',
    // Fallback mobile nodePaths shares React but cannot override already-resolved shared imports; Zod needs its own alias.
    nodePaths: [join(mobileDir, 'node_modules')],
    alias: {
      'react-native': 'react-native-web',
      '@react-native-async-storage/async-storage': PAGE_ASYNC_STORAGE_MODULE,
      zod: MOBILE_ZOD_PACKAGE
    },
    plugins: [
      routeManifestPlugin(
        renderMobileWebAppRouteManifest(routes),
        routes,
        sharedModules,
        anchoredLazyModules
      ),
      lucideBarrelPlugin,
      hairlineDevicePixelPlugin
    ],
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
    // Emit hashed same-origin images/font for reproducible IDs without base64 overhead in chunks; runtime previews may still use data URLs.
    loader: {
      ...ROUTE_SOURCE_LOADERS,
      '.png': 'file',
      '.jpg': 'file',
      '.jpeg': 'file',
      '.gif': 'file',
      '.webp': 'file',
      '.svg': 'file',
      '.woff2': 'file'
    },
    assetNames: '[hash]',
    // Root-absolute asset URLs remain correct at nested page routes.
    publicPath: '/assets',
    banner: {
      js: `globalThis.process ??= { env: { NODE_ENV: 'production', EXPO_OS: 'web' }, platform: 'web', version: '', nextTick: (fn) => setTimeout(fn, 0) };${ZOD_JITLESS_BANNER}`
    },
    define: {
      global: 'globalThis',
      __DEV__: 'false',
      'process.env.NODE_ENV': '"production"',
      'process.env.EXPO_OS': '"web"',
      'process.env.EXPO_ROUTER_IMPORT_MODE': '"sync"',
      // Only a switch asked for: an off build stays byte-identical, and its switch reads off.
      ...turnedOnDarkBuildDefines()
    }
  }
}

// Hash final output bytes leaf-first, rewriting dependency names before hashing importers.
// esbuild hashes checkout-dependent input paths; renaming makes manifest hashes/import URLs agree and avoids redownloading identical bundles across checkouts.
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
      // Cyclic import names have no final content hash; fail rather than fallback (esbuild currently emits a DAG).
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

// Resolve route imports through metafile inputs before content hashes erase source paths.
export function routeChunkNames(metafile, routes, renamed) {
  const owner = new Map()
  for (const [output, { inputs }] of Object.entries(metafile.outputs)) {
    for (const input of Object.keys(inputs ?? {})) {
      // realpath lookup matches esbuild’s symlink-resolved input keys (including macOS /var scratch paths).
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

// appDir is a seam for the tests, which bundle a scratch route tree; production always uses mobile/app.
// Page closure includes ancestor layouts as entry modules, not just route imports.
export async function mobileWebAppRouteClosure(routeModule) {
  return (
    readRouteSnapshot(routeModule) ??
    (await mobileWebAppModuleClosure(['app/_layout', 'app/h/_layout', routeModule]))
  )
}

// Measure source-module closure via metafile.inputs, distinct from browser static download closure.
// Support standalone components or layout+component; multi-entry builds need splitting:false and per-path output names.
// Parity pins use the C1.6 method, so divergence from this closure is a finding to investigate.
export async function mobileWebAppModuleClosure(entryModules, { absWorkingDir } = {}) {
  const base = mobileWebAppBuildOptions(MOBILE_WEB_PAGE_ROUTES)
  const result = await esbuild.build({
    ...base,
    // Census mutation needs its own source tree; production measures mobile/.
    ...(absWorkingDir ? { absWorkingDir } : {}),
    // Resolve extensionless routes so web siblings win; explicit .tsx would measure native-only code.
    entryPoints: entryModules.map((entry) =>
      resolve(absWorkingDir ?? base.absWorkingDir, entry.replace(/\.tsx?$/, ''))
    ),
    splitting: false,
    // `[dir]` too: `app/_layout` and `app/h/_layout` share a name.
    entryNames: '[dir]/[name]',
    plugins: base.plugins.filter((plugin) => plugin.name !== ROUTE_MANIFEST_PLUGIN_NAME),
    write: false,
    metafile: true,
    logLevel: 'silent'
  })
  const inputs = Object.keys(result.metafile.inputs)
  return {
    modules: inputs,
    /** Everything outside `node_modules`: this repository's own source, which a census reads. */
    local: inputs.filter((input) => !input.includes('node_modules'))
  }
}

// One lazily imported chunk per UI language; the page fetches only the active one after init.
const LOCALE_CATALOG_INPUT = /(^|\/)src\/i18n\/locales\/[^/]+\.json$/
const localeCatalogDir = join(mobileDir, 'src', 'i18n', 'locales')

// The same catalogs as JSON for the host to serve one at a time, to shells that skip the chunks;
// English is the page's inline fallback, so it has none.
export async function readLocaleCatalogs(directory = localeCatalogDir) {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.json') && name !== 'en.json')
    .sort()
  return Promise.all(
    names.map(async (name) => {
      // Minify: the host sends and the phone keeps the parsed object, not the source layout.
      const bytes = Buffer.from(
        JSON.stringify(JSON.parse(await readFile(join(directory, name), 'utf8'))),
        'utf8'
      )
      const sha256 = sha256Hex(bytes)
      return {
        locale: name.slice(0, -'.json'.length),
        bytes,
        path: `catalogs/${sha256}.json`,
        sha256,
        byteLength: bytes.byteLength
      }
    })
  )
}

function localeCatalogOutputs(metafile) {
  return new Set(
    Object.entries(metafile.outputs)
      .filter(([, output]) => {
        const inputs = Object.keys(output.inputs ?? {})
        return inputs.length > 0 && inputs.every((input) => LOCALE_CATALOG_INPUT.test(input))
      })
      .map(([output]) => basename(output))
  )
}

// The entry and its chunks, without locale catalogs: what the chunk fence and its sweep table count.
export function pageScriptCount(metafile) {
  const catalogs = localeCatalogOutputs(metafile)
  return Object.keys(metafile.outputs).filter(
    (output) => isScriptOutput(output) && !catalogs.has(basename(output))
  ).length
}

// esbuild keeps a whole namespace used as a value: `import { z }` or `z.core` ships ~200 KB of zod locale tables.
const ZOD_LOCALE_TABLE_INPUT = /\/zod\/v4\/locales\/(?!en\.js$)[^/]+$/

function assertNoZodLocaleTables(metafile) {
  const leaked = Object.values(metafile.outputs).flatMap(({ inputs }) =>
    Object.entries(inputs)
      .filter(
        ([input, { bytesInOutput }]) => bytesInOutput > 0 && ZOD_LOCALE_TABLE_INPUT.test(input)
      )
      .map(([input]) => input)
  )
  if (leaked.length > 0) {
    throw new Error(
      `[build-mobile-web-app-bundle] ${String(leaked.length)} zod locale tables reached the page (${leaked[0]}, …); ` +
        "use `import * as z from 'zod'`, and import nested namespaces like `z.core` directly"
    )
  }
}

function entryOutput(metafile) {
  const path = Object.keys(metafile.outputs).find(
    (output) => basename(output) === `${ENTRY_CHUNK_NAME}.js`
  )
  if (!path) {
    throw new Error('[build-mobile-web-app-bundle] esbuild emitted no entry script')
  }
  return path
}

// The page's scripts as shipped: a first build finds the small shared chunks, a second merges them.
export async function buildMobileWebAppScripts(routes) {
  const split = await esbuild.build(mobileWebAppBuildOptions(routes))
  const entryOutputPath = entryOutput(split.metafile)
  const sharedModules = sharedModulesToMerge(split.metafile, entryOutputPath)
  const anchoredLazyModules = lazyModulesToAnchor(split.metafile, entryOutputPath)
  return sharedModules.length === 0 && anchoredLazyModules.size === 0
    ? split
    : esbuild.build(mobileWebAppBuildOptions(routes, sharedModules, anchoredLazyModules))
}

export async function bundleMobileWebApp({ appDir = defaultAppDir } = {}) {
  const routes = await collectMobileWebAppRoutes(appDir)
  await assertRoutesCarryNoSynchronousExports(routes)
  const result = await buildMobileWebAppScripts(routes)
  assertNoZodLocaleTables(result.metafile)
  const entryOutputPath = entryOutput(result.metafile)
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
  const catalogOutputs = localeCatalogOutputs(result.metafile)
  return {
    script: entry.bytes,
    chunks,
    images,
    catalogChunks: chunks.filter(({ emittedName }) => catalogOutputs.has(emittedName)),
    // Count final renamed bytes; metafile sizes predate longer hashes but still identify static imports.
    entryStaticBytes: [...closure].reduce(
      (total, path) => total + (renamed.get(basename(path))?.bytes.byteLength ?? 0),
      0
    ),
    chunkCount: pageScriptCount(result.metafile),
    routeKeys: routes.map((route) => route.key),
    routeChunks: routeChunkNames(result.metafile, routes, renamed)
  }
}

// Reject declared screens missing from bundled tree or phones silently paint Unmatched routes.
export function resolveMobileWebPageRoutes(routeKeys, declared = MOBILE_WEB_PAGE_ROUTES) {
  const bundled = new Set(routeKeys.map(routePathnameFromKey).filter((path) => path !== null))
  for (const route of declared) {
    if (!bundled.has(route.pathname)) {
      throw new Error(
        `[build-mobile-web-app-bundle] declared page route ${route.pathname} has no module in the bundle`
      )
    }
  }
  // Update this explicit mapping when declarations gain fields or the strict manifest silently drops them (e.g. optionalGrants).
  // Omit empty optionalGrants since shell treats absent/empty identically.
  return declared.map((route) => ({
    pathname: route.pathname,
    grants: [...route.grants],
    ...(route.optionalGrants === undefined || route.optionalGrants.length === 0
      ? {}
      : { optionalGrants: [...route.optionalGrants] }),
    ...(route.canOwnHostArea === true ? { canOwnHostArea: true } : {}),
    ...(route.canOwnHostAreaAcrossLayouts === true ? { canOwnHostAreaAcrossLayouts: true } : {})
  }))
}

// Alternate appDir needs matching pageRoutes because real declarations name only the production tree.
export async function buildMobileWebAppBundle({
  appDir,
  outDir = defaultOutDir,
  pageRoutes = MOBILE_WEB_PAGE_ROUTES,
  // Only the shipped tree pays for brotli-11; tests and verify's scratch builds read raw assets.
  brotli = false
} = {}) {
  const [
    desktopVersion,
    protocolWindow,
    { script, chunks, images, catalogChunks, entryStaticBytes, chunkCount, routeChunks, routeKeys },
    catalogs,
    scrollbarStyle
  ] = await Promise.all([
    readDesktopVersion(),
    readProtocolWindow(),
    bundleMobileWebApp({ appDir }),
    readLocaleCatalogs(),
    readFile(join(projectDir, 'src/shared/styles/scrollbar-sleek.css'), 'utf8').then((style) =>
      // The shared desktop stylesheet can be checked out as CRLF on Windows.
      style.replace(/\r\n/g, '\n')
    )
  ])
  // Names already hash final bytes, so hashedAsset must reproduce them.
  const scriptAsset = hashedAsset(script, 'js')
  const catalogChunkSet = new Set(catalogChunks)
  const written = [
    scriptAsset,
    ...[...chunks, ...images].map((output) => ({
      ...hashedAsset(output.bytes, extname(output.name).slice(1)),
      // Shells that read catalogs from the host skip these; older shells download them as before.
      ...(catalogChunkSet.has(output) ? { kind: 'catalog' } : {})
    }))
  ]

  // Root-absolute URLs survive nested routes; CSP allows only about: base. ESM entry/chunks load under existing self policy.
  const html =
    '<!doctype html>\n<html lang="en" data-orca-scrollbars="sleek">\n<head>\n<meta charset="utf-8" />\n' +
    // Shell owns safe-area padding/insets; viewport-fit=cover would invite page-side double padding.
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    // Empty favicon prevents repeated unmanifested /favicon.ico requests/403s; WebView needs no tab icon asset.
    '<link rel="icon" href="data:," />\n' +
    `<title>Orca</title>\n${MOBILE_WEB_APP_ROOT_RESET}\n${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}\n<style id="orca-scrollbars">${scrollbarStyle}</style>\n</head>\n<body>\n<div id="root"></div>\n` +
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
    catalogs,
    desktopVersion,
    protocolWindow,
    routes: resolveMobileWebPageRoutes(routeKeys, pageRoutes),
    brotli
  })
  return {
    manifest,
    outDir,
    routeChunks,
    routeKeys,
    entryStaticBytes,
    chunkCount,
    // Everything the routes import that is not a script, which is the rest of the asset budget.
    imageCount: images.length,
    catalogChunkCount: catalogChunks.length,
    catalogBytes: catalogChunks.reduce((total, { bytes }) => total + bytes.byteLength, 0)
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  if (!existsSync(MOBILE_WEB_APP_DEPENDENCY_PATH)) {
    console.error(
      '[build-mobile-web-app-bundle] mobile/ dependencies are not installed; run `pnpm -C mobile install --frozen-lockfile`'
    )
    process.exit(1)
  }
  try {
    const { manifest, outDir, routeKeys, entryStaticBytes, chunkCount } =
      await buildMobileWebAppBundle({ brotli: true })
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
