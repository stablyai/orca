import { realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_BUILD_PLUGIN_NAME = 'orca-one-package-build'
const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Same module, one copy: each import would otherwise bundle a second build the page already ships.
const PACKAGE_BUILD_REDIRECTS = [
  {
    // gesture-handler probes reanimated's TS source by subpath, adding 140 KB of reanimated/src beside lib/module.
    from: 'react-native-reanimated/src/createAnimatedComponent/AnimatedComponent',
    to: 'react-native-reanimated/lib/module/createAnimatedComponent/AnimatedComponent.js'
  },
  {
    // reanimated's web style helpers reach react-native-web's cjs build beside its esm one.
    from: 'react-native-web/dist/cjs/exports/StyleSheet/compiler/createReactDOMStyle.js',
    to: 'react-native-web/dist/exports/StyleSheet/compiler/createReactDOMStyle.js'
  },
  {
    from: 'react-native-web/dist/cjs/exports/StyleSheet/preprocess.js',
    to: 'react-native-web/dist/exports/StyleSheet/preprocess.js'
  },
  {
    // markdown-it only decodes; the package root also keeps a 23 KB encode map esbuild can't drop.
    from: 'entities',
    to: 'entities/lib/decode.js',
    importer: /[\\/]markdown-it[\\/]/
  },
  {
    // The root re-exports every navigator (tabs, error boundary) as CommonJS esbuild can't tree-shake.
    from: 'expo-router',
    to: fileURLToPath(new URL('../../../../mobile/web-entry/expo-router-page.ts', import.meta.url))
  },
  {
    // expo-router always registers its /_sitemap developer index; only its not-found screen links there.
    from: './views/Sitemap',
    to: fileURLToPath(
      new URL('../../../../mobile/web-entry/expo-router-sitemap.ts', import.meta.url)
    ),
    importer: /[\\/]expo-router[\\/]build[\\/][^\\/]+\.js$/
  },
  {
    // Navigator.js only reads StackRouter from StackClient, which otherwise pulls native-stack, elements, and react-native-screens into boot.
    from: '../layouts/StackClient',
    to: 'expo-router/build/layouts/stack-router.js',
    importer: /[\\/]expo-router[\\/]build[\\/]views[\\/]Navigator\.js$/
  },
  {
    // Toast.js only reads BottomTabBarHeightContext from bottom-tabs, which otherwise pulls BottomTabBar and react-navigation/elements into boot.
    from: '../react-navigation/bottom-tabs',
    to: 'expo-router/build/react-navigation/bottom-tabs/utils/BottomTabBarHeightContext.js',
    importer: /[\\/]expo-router[\\/]build[\\/]views[\\/]Toast\.js$/
  },
  {
    // reanimated marks its root barrel side-effectful, keeping 40+ unused layout animations, CSS animations, and jestUtils.
    from: 'react-native-reanimated',
    to: fileURLToPath(new URL('../../../../mobile/web-entry/reanimated-page.mjs', import.meta.url))
  },
  {
    // gesture-handler has no sideEffects field, keeping legacy touchables, components, handlers, and unused v3 hooks.
    from: 'react-native-gesture-handler',
    to: fileURLToPath(
      new URL('../../../../mobile/web-entry/gesture-handler-page.mjs', import.meta.url)
    )
  },
  {
    // The page only renders SVG elements (no SvgXml/SvgUri/CSS parsing); elements.web.js drops xml.js, transformToRn.js, and SvgTouchableMixin.js.
    from: 'react-native-svg',
    to: 'react-native-svg/lib/module/elements.web.js'
  },
  {
    // These subpaths resolve to the CommonJS build, which keeps all of sha2 (sha512 too); the esm one shakes.
    from: '@noble/hashes/sha256',
    to: '@noble/hashes/esm/sha256.js'
  },
  {
    from: '@noble/hashes/utils',
    to: '@noble/hashes/esm/utils.js'
  },
  {
    // react-native-web pins an older color parser than expo-router's; every importer takes expo-router's,
    // the one react-native ships to the phone app, so both parse a color alike.
    from: '@react-native/normalize-colors',
    to: '@react-native/normalize-colors',
    via: 'expo-router'
  }
]

// Find `via` as the app depends on it, then its own copy of `dependency`: resolving from inside the
// package finds that copy, and the copy's real path is what the result must land in. Without that check
// a `via` that drops the dependency would silently get whichever version is hoisted further up.
// The marker skips the redirects: expo-router's own one points at the page's shim, not the package.
async function viaDependency(build, via, dependency) {
  const { path, errors } = await build.resolve(via, {
    kind: 'import-statement',
    resolveDir: mobileDir,
    pluginData: { [PACKAGE_BUILD_PLUGIN_NAME]: true }
  })
  if (errors.length > 0) {
    throw new Error(`${PACKAGE_BUILD_PLUGIN_NAME}: ${via} no longer resolves`)
  }
  const packageMarker = `${sep}node_modules${sep}${via.split('/').join(sep)}${sep}`
  const at = path.lastIndexOf(packageMarker)
  if (at === -1) {
    throw new Error(`${PACKAGE_BUILD_PLUGIN_NAME}: ${via} resolved outside node_modules (${path})`)
  }
  const ownLink = join(path.slice(0, at), 'node_modules', dependency)
  let own
  try {
    own = realpathSync(ownLink)
  } catch {
    throw new Error(
      `${PACKAGE_BUILD_PLUGIN_NAME}: ${via} no longer depends on ${dependency} itself`
    )
  }
  return { resolveDir: dirname(path), own }
}

export const packageBuildPlugin = {
  name: PACKAGE_BUILD_PLUGIN_NAME,
  setup(build) {
    const filter = new RegExp(
      `^(?:${PACKAGE_BUILD_REDIRECTS.map(({ from }) => escapeRegExp(from)).join('|')})$`
    )
    build.onResolve({ filter }, async (args) => {
      // A redirect to its own specifier comes back through here; let esbuild resolve that one.
      if (args.pluginData?.[PACKAGE_BUILD_PLUGIN_NAME]) {
        return undefined
      }
      const redirect = PACKAGE_BUILD_REDIRECTS.find(
        ({ from, importer }) => from === args.path && (!importer || importer.test(args.importer))
      )
      if (!redirect) {
        return undefined
      }
      const via = redirect.via ? await viaDependency(build, redirect.via, redirect.to) : null
      const { path, namespace, sideEffects, errors } = await build.resolve(redirect.to, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: via ? via.resolveDir : args.resolveDir,
        pluginData: { [PACKAGE_BUILD_PLUGIN_NAME]: true }
      })
      // An upgrade that moves the target fails the build instead of shipping both copies again.
      if (errors.length > 0) {
        throw new Error(`${PACKAGE_BUILD_PLUGIN_NAME}: ${redirect.to} no longer resolves`)
      }
      if (via && !realpathSync(path).startsWith(`${via.own}${sep}`)) {
        throw new Error(
          `${PACKAGE_BUILD_PLUGIN_NAME}: ${redirect.to} resolved to ${path}, not ${redirect.via}'s own copy at ${via.own}`
        )
      }
      return { path, namespace, sideEffects }
    })
  }
}
