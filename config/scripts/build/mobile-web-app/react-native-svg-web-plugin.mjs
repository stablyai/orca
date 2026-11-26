import { fileURLToPath } from 'node:url'

const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))

// react-native-svg 15.16 reaches two native-only modules from its web build: the asset registry RN 0.88
// folded into react-native (react-native-web keeps its own), and an Android touch-sound TurboModule
// it requires only when Platform.OS is android. Shared with the render checks so they bundle alike.
export const reactNativeSvgWebPlugin = {
  name: 'react-native-svg-web',
  setup(build) {
    build.onResolve({ filter: /^@react-native\/assets-registry\/registry$/ }, () =>
      build.resolve('react-native-web/dist/modules/AssetRegistry', {
        kind: 'import-statement',
        resolveDir: mobileDir
      })
    )
    build.onResolve({ filter: /[\\/]fabric[\\/]NativeSvgSoundModule$/ }, (args) => ({
      path: args.path,
      namespace: 'react-native-svg-web-stub'
    }))
    build.onLoad({ filter: /.*/, namespace: 'react-native-svg-web-stub' }, () => ({
      contents: 'export default { playTouchSound() {} };',
      loader: 'js'
    }))
  }
}
