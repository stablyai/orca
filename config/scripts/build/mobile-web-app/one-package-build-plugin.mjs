import { dirname } from 'node:path'

const PACKAGE_BUILD_PLUGIN_NAME = 'orca-one-package-build'

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
    // react-native-web pins an older color parser than expo-router's; every importer takes expo-router's,
    // the one react-native ships the phone app, so both parse a color alike.
    from: '@react-native/normalize-colors',
    to: '@react-native/normalize-colors',
    via: 'expo-router'
  }
]

// Resolve from inside the package, so a bare import finds the copy that package itself resolves.
async function packageDir(build, name, args) {
  const { path, errors } = await build.resolve(name, {
    kind: args.kind,
    importer: args.importer,
    resolveDir: args.resolveDir
  })
  if (errors.length > 0) {
    throw new Error(`${PACKAGE_BUILD_PLUGIN_NAME}: ${name} no longer resolves`)
  }
  return dirname(path)
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
      const { path, namespace, sideEffects, errors } = await build.resolve(redirect.to, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: redirect.via ? await packageDir(build, redirect.via, args) : args.resolveDir,
        pluginData: { [PACKAGE_BUILD_PLUGIN_NAME]: true }
      })
      // An upgrade that moves the target fails the build instead of shipping both copies again.
      if (errors.length > 0) {
        throw new Error(`${PACKAGE_BUILD_PLUGIN_NAME}: ${redirect.to} no longer resolves`)
      }
      return { path, namespace, sideEffects }
    })
  }
}
