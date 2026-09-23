import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
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
import { isDirectInvocation } from './script-entry-detection.mjs'
import {
  ROUTE_SOURCE_LOADERS,
  assertRoutesCarryNoSynchronousExports,
  collectMobileWebAppRoutes,
  renderMobileWebAppRouteManifest,
  routePathnameFromKey
} from './mobile-web-app-route-manifest.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const mobileDir = join(projectDir, 'mobile')
const defaultAppDir = join(mobileDir, 'app')
const entryPoint = join(mobileDir, 'web-entry', 'index.tsx')
// The one definition of where the packaged bundle lives, taken from the guard that enforces it:
// a second constant here could drift and leave electron-builder's beforePack looking at an empty
// directory while the builder reported a tree it had written somewhere else.
const { MOBILE_WEB_BUNDLE_DIR: defaultOutDir } = createRequire(import.meta.url)(
  './verify-packaged-mobile-web-bundle.cjs'
)

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
    // Zod probes for a usable JIT with `new Function('')`, which the shell's CSP reports even
    // though Zod catches the throw and runs interpreted. Turned off before any module, because a
    // schema constructed at module scope reaches the probe before our own code can run.
    name: 'zod-jitless-banner',
    appliesTo: (options) => options.banner?.js?.includes('__zod_globalConfig') === true
  },
  {
    // Four modules under src/shared resolve `zod` upward to the root's copy, so the page bundled
    // two Zods and built salvage combinators with one instance to nest inside schemas built by the
    // other. mobile/tsconfig.json already maps `zod` to mobile's for the whole mobile program,
    // those shared modules included; this is the bundler catching up to that contract.
    name: 'one-zod',
    appliesTo: (options) => options.alias?.zod === MOBILE_ZOD_PACKAGE
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
    // AsyncStorage's web build is window.localStorage, which the shell's page does not have:
    // Android turns DOM storage off and on iOS the origin host is the session id, so anything
    // written there is gone on the next remount. The page module holds the app's own values,
    // primed by `init` and written back over the `storage` grant.
    name: 'async-storage-over-the-bridge',
    appliesTo: (options) =>
      options.alias?.['@react-native-async-storage/async-storage'] === PAGE_ASYNC_STORAGE_MODULE
  },
  {
    // react-native-web pins StyleSheet.hairlineWidth to 1 CSS px, three device px on a phone.
    // Native's value is one device px, so the page takes native's formula at that assignment.
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

/**
 * react-native-web's own root reset: the same declaration set and `id="expo-reset"` as Expo's web
 * template (`@expo/cli/static/template/index.html`), minified — the template's own block is
 * pretty-printed with comments, so this is 112 bytes against its 410. Nothing generates it for a
 * document built here.
 *
 * Every box below the mount is `flex: 1` against its parent, so with no definite height on all
 * three the root measures 0 and the collapse is silent: the screen still lays out, still reaches
 * the accessibility tree at the right offsets, and never paints or hit-tests below the header.
 * A phone showed the header over a blank list with every row readable to VoiceOver and no row
 * tappable (lane C1.7, both platforms).
 *
 * Inline, because the shell's CSP already allows `style-src 'unsafe-inline'` for the sheet
 * react-native-web injects at runtime; a linked asset would need a second round trip before the
 * first frame and would paint the collapsed layout until it landed.
 *
 * Height, `overflow` and the root's flex box and nothing else, which is what the template carries:
 * react-native-web emits `body{margin:0}` in that runtime sheet, so a copy here would only cover
 * the frames before it lands and would make this string something to keep in step with two sources.
 */
export const MOBILE_WEB_APP_ROOT_RESET =
  '<style id="expo-reset">html,body{height:100%}body{overflow:hidden}' +
  '#root{display:flex;height:100%;flex:1}</style>'

/**
 * Rules that make the page paint what the native app paints where the browser's defaults differ.
 * Native is the reference. Zero specificity (`:where`), so a component's own style still wins.
 *
 * Text inputs: Chromium rings a focused input (`:focus-visible` matches every focused text field);
 * no native TextInput paints one, and the caret plus the IME already mark focus on a phone.
 * Inputs only: a button reached by a hardware keyboard keeps the browser's ring.
 */
export const MOBILE_WEB_APP_NATIVE_PARITY_STYLE =
  '<style id="orca-native-parity">:where(input:focus,textarea:focus){outline:none}</style>'

const PAGE_ASYNC_STORAGE_MODULE = join(
  mobileDir,
  'src',
  'mobile-web-shell',
  'bridge',
  'page-async-storage.ts'
)

/**
 * The one Zod the page runs.
 *
 * `nodePaths` is a fallback, consulted only where normal resolution fails, so it never reached
 * `src/shared/zod-salvage.ts`: that file sits above `mobile/`, its bare `zod` resolves upward to
 * the root's 4.5.4, and the 58 mobile modules beside it resolved to mobile's 4.4.3. Both shipped.
 *
 * Mobile's copy and not the root's, because the mobile app already says so: `mobile/tsconfig.json`
 * maps `zod` to `./node_modules/zod`, and a shared module joins that program as an imported file,
 * so tsc holds `zod-salvage.ts` to 4.4.3 today. The composition says the same thing from the other
 * side — `salvagingArray` and friends are leaves nested inside `z.object(...)` built by mobile's
 * Zod, so the leaves belong to the container's instance.
 *
 * The package directory rather than a file: nothing imports a `zod/...` subpath, and esbuild reads
 * the `module` field here, which is the same ESM entry the package's `import` condition names.
 */
const MOBILE_ZOD_PACKAGE = join(mobileDir, 'node_modules', 'zod')

/**
 * Zod's compiled path, off before any module runs.
 *
 * Zod decides whether it may compile by constructing `new Function('')` and reading the throw as
 * "no JIT here". Under the shell's `script-src 'self'` that throw is exactly what happens, Zod
 * catches it and takes the interpreted path — but the browser files a `securitypolicyviolation`
 * report first, and it does so on every page load. Zod's own source gates the probe on `jitless`
 * for this case, so nothing here is a workaround.
 *
 * In the banner rather than a module that calls `z.config`, because a module cannot win the race.
 * `$ZodObject` reads `allowsEval` when a schema is *constructed*, not parsed, so the first
 * module-scope `z.object(...)` in the bundle fires the probe — and esbuild evaluates the chunk
 * holding zod and its callers before the chunk holding any module of ours that imports zod. An
 * entry import placed first was measured losing that race; the banner runs before every module.
 *
 * `globalConfig` is `globalThis.__zod_globalConfig`, which zod adopts with `??=` rather than
 * replacing, so setting the flag on it here is what zod itself reads.
 */
const ZOD_JITLESS_BANNER =
  'globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;'

const ROUTE_MANIFEST_PLUGIN_NAME = 'orca-route-manifest'
const LUCIDE_PLUGIN_NAME = 'orca-lucide-barrel-provider'
const HAIRLINE_PLUGIN_NAME = 'orca-hairline-device-pixel'

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

/**
 * Exported so a component-level render check builds the icons the same way the page does, rather
 * than carrying a second copy of this shim that could drift from it.
 */
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
// React Native's formula (Libraries/StyleSheet/StyleSheetExports.js): roundToNearestPixel(0.4),
// else one device pixel. Chromium at a real device scale paints that as one device pixel.
const DEVICE_PIXEL_HAIRLINE_ASSIGNMENT =
  'StyleSheet.hairlineWidth = (function (ratio) { return Math.round(0.4 * ratio) / ratio || 1 / ratio; })' +
  "(typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);"

const hairlineDevicePixelPlugin = {
  name: HAIRLINE_PLUGIN_NAME,
  setup(build) {
    build.onLoad(
      // Both builds: once any dependency requires the package, esbuild resolves every importer to cjs.
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
    // A fallback only, so it settles nothing for a module that resolves on its own — see
    // MOBILE_ZOD_PACKAGE, which is a repo-root import this never reached.
    nodePaths: [join(mobileDir, 'node_modules')],
    alias: {
      'react-native': 'react-native-web',
      '@react-native-async-storage/async-storage': PAGE_ASYNC_STORAGE_MODULE,
      zod: MOBILE_ZOD_PACKAGE
    },
    plugins: [
      routeManifestPlugin(renderMobileWebAppRouteManifest(routes)),
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
    // Images are emitted as same-origin assets, not data: URLs, so their content-hashed names keep
    // the buildId reproducible and the bytes out of every chunk that imports one. The policy now
    // admits data: for images, but that is for a preview the page composes at runtime, not for a
    // bundled asset. A font would fail the build here rather than silently ship under font-src 'none'.
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
      js: `globalThis.process ??= { env: { NODE_ENV: 'production', EXPO_OS: 'web' }, platform: 'web', version: '', nextTick: (fn) => setTimeout(fn, 0) };${ZOD_JITLESS_BANNER}`
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
/**
 * Every source module one page route reaches, as the builder itself resolves them.
 *
 * Both entry points are needed: `app/h/_layout.tsx` wraps every route under it, and its imports are
 * part of the page as surely as the route module's.
 */
export async function mobileWebAppRouteClosure(routeModule) {
  return await mobileWebAppModuleClosure(['app/h/_layout', routeModule])
}

/**
 * The same closure for any entry modules, which a route plus the layout is one case of.
 *
 * One definition of "what a page contains", read from `metafile.inputs` — the modules the entries
 * pull in — rather than from `entryStaticClosure`, which walks emitted chunks and answers what a
 * browser must download.
 *
 * A component a route mounts rather than one the router registers — `MobileBrowserPane` is the
 * first with a pin of its own — has a closure to certify and no route to name it by. Pass it alone
 * to read what it reaches on its own, or beside `app/h/_layout` to read what it adds to a page.
 *
 * `splitting: false` and a per-name output are required for a multi-entry build; with the defaults
 * esbuild fails on two outputs claiming `dist/entry.js`.
 *
 * Note for anyone comparing this with a parity pin: `c1-page-closure.ts`, and the closures C2.6,
 * C5.2 and C3.2 generate, derive theirs by the C1.6 method inside the mobile suite. The two are
 * not the same computation, and a divergence between them is a finding rather than noise.
 */
export async function mobileWebAppModuleClosure(entryModules, { absWorkingDir } = {}) {
  const base = mobileWebAppBuildOptions(MOBILE_WEB_PAGE_ROUTES)
  const result = await esbuild.build({
    ...base,
    // A census that plants a module to show the walk would report it needs a tree of its own; the
    // real ones never pass this and keep measuring `mobile/`.
    ...(absWorkingDir ? { absWorkingDir } : {}),
    // Extensionless, so `resolveExtensions` picks the same file the bundle ships: a route with a
    // `.web.tsx` sibling resolves to that one, and naming the `.tsx` path explicitly would measure
    // the native switch no browser ever loads.
    entryPoints: entryModules.map((entry) => entry.replace(/\.tsx?$/, '')),
    splitting: false,
    entryNames: '[name]',
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

/**
 * The declared page routes, checked against the tree that was actually bundled.
 *
 * A declaration naming a screen this bundle has no module for would reach a phone as a route the
 * shell opens the page for and the page then paints as Unmatched. Failing the build is the only
 * place that mismatch is visible to whoever wrote the declaration.
 */
export function resolveMobileWebPageRoutes(routeKeys, declared = MOBILE_WEB_PAGE_ROUTES) {
  const bundled = new Set(routeKeys.map(routePathnameFromKey).filter((path) => path !== null))
  for (const route of declared) {
    if (!bundled.has(route.pathname)) {
      throw new Error(
        `[build-mobile-web-app-bundle] declared page route ${route.pathname} has no module in the bundle`
      )
    }
  }
  // Mapped member by member rather than spread: the manifest is `.strict()`, so a field this
  // declaration grows and this map does not name is dropped in silence -- which is how
  // `optionalGrants` would have reached a phone as a route that declared nothing optional.
  // `optionalGrants` is omitted when the route declares none, because absent and empty are the same
  // answer to a shell and a key written empty would be a manifest field with no reader.
  return declared.map((route) => ({
    pathname: route.pathname,
    grants: [...route.grants],
    ...(route.optionalGrants === undefined || route.optionalGrants.length === 0
      ? {}
      : { optionalGrants: [...route.optionalGrants] })
  }))
}

/**
 * `pageRoutes` rides with `appDir`: the declarations name screens in the real route tree, so a
 * caller bundling some other tree has none to check against and says so by passing its own.
 */
export async function buildMobileWebAppBundle({
  appDir,
  outDir = defaultOutDir,
  pageRoutes = MOBILE_WEB_PAGE_ROUTES
} = {}) {
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
    // Undeclared, a browser asks the origin for /favicon.ico itself and the shell's asset server
    // answers 403, the path being in no manifest. Empty rather than an asset: a WebView document
    // has no tab for an icon, and the bundle's images are route assets named by their own bytes.
    '<link rel="icon" href="data:," />\n' +
    `<title>Orca</title>\n${MOBILE_WEB_APP_ROOT_RESET}\n${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}\n</head>\n<body>\n<div id="root"></div>\n` +
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
    protocolWindow,
    routes: resolveMobileWebPageRoutes(routeKeys, pageRoutes)
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
