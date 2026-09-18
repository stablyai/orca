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
 * The module whose body the builder replaces. A real typed file rather than a virtual specifier,
 * so the entry typechecks and Metro can still resolve it.
 */
export const ROUTE_MANIFEST_MODULE = 'mobile/web-entry/route-manifest.ts'

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
    format: 'iife',
    target: ['es2022'],
    charset: 'utf8',
    legalComments: 'none',
    // Why no sourcemap and no metafile: both embed absolute paths, which would break reproducibility.
    sourcemap: false,
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

// appDir is a seam for the tests, which bundle a scratch route tree; production always uses mobile/app.
export async function bundleMobileWebApp({ appDir = defaultAppDir } = {}) {
  const routes = await collectMobileWebAppRoutes(appDir)
  const result = await esbuild.build(mobileWebAppBuildOptions(routes))
  const script = result.outputFiles.find((file) => file.path.endsWith('.js'))
  if (!script) {
    throw new Error('[build-mobile-web-app-bundle] esbuild emitted no script')
  }
  const images = result.outputFiles
    .filter((file) => file !== script)
    .map((file) => ({ name: basename(file.path), bytes: Buffer.from(file.contents) }))
    .sort((left, right) => (left.name < right.name ? -1 : 1))
  return {
    script: Buffer.from(script.contents),
    images,
    routeKeys: routes.map((route) => route.key)
  }
}

export async function buildMobileWebAppBundle({ outDir = defaultOutDir } = {}) {
  const [desktopVersion, protocolWindow, { script, images, routeKeys }] = await Promise.all([
    readDesktopVersion(),
    readProtocolWindow(),
    bundleMobileWebApp()
  ])
  const scriptAsset = hashedAsset(script, 'js')
  // esbuild already named these by content hash; keep that name so the reference inside the
  // script stays valid, and carry the sha256 in the manifest entry as every asset does.
  const imageAssets = images.map(({ name, bytes }) => ({
    bytes,
    path: `assets/${name}`,
    sha256: sha256Hex(bytes),
    byteLength: bytes.byteLength,
    contentType: contentTypeForExtension(extname(name).slice(1))
  }))

  // Root-absolute, unlike the Phase A bootstrap's bare relative src: this document is served at
  // every route depth (/h/<hostId>/tasks), where a relative href resolves against the route and
  // 404s. A <base> tag would be the other fix, but the shell's CSP sets base-uri 'none'.
  const html =
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n' +
    '<title>Orca</title>\n</head>\n<body>\n<div id="root"></div>\n' +
    `<script src="/${scriptAsset.path}"></script>\n</body>\n</html>\n`
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
    written: [indexAsset, scriptAsset, ...imageAssets],
    desktopVersion,
    protocolWindow
  })
  return { manifest, outDir, routeKeys }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const { manifest, outDir, routeKeys } = await buildMobileWebAppBundle()
  console.log(
    `[build-mobile-web-app-bundle] OK — ${String(routeKeys.length)} route(s), ` +
      `${String(manifest.assets.length)} asset(s), ${String(manifest.totalBytes)} bytes, ` +
      `buildId ${manifest.buildId} -> ${outDir}`
  )
}
