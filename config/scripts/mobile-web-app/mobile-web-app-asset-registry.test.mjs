import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { expect, it } from 'vitest'
import { mobileWebAppBuildOptions } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile', import.meta.url))

it.skipIf(!mobileWebAppDependenciesPresent())(
  'lets SVG resolve numeric assets registered by React Native Web',
  async () => {
    const svgResolver = join(
      mobileDir,
      'node_modules/react-native-svg/lib/module/lib/resolveAssetUri.web.js'
    )
    const result = await esbuild.build({
      ...mobileWebAppBuildOptions([]),
      entryPoints: undefined,
      stdin: {
        contents: `import { registerAsset } from 'react-native-web/dist/modules/AssetRegistry';
        import { resolveAssetUri } from ${JSON.stringify(svgResolver)};
        export const resolved = resolveAssetUri(registerAsset({
          width: 20, height: 30, scales: [1], httpServerLocation: '/assets', name: 'picture', type: 'png'
        }));`,
        resolveDir: mobileDir,
        loader: 'js'
      },
      format: 'cjs',
      splitting: false
    })
    const compiled = result.outputFiles.find((file) => file.path.endsWith('.js'))
    if (!compiled) {
      throw new Error('the asset fixture did not produce JavaScript')
    }
    const module = { exports: {} }
    new Function('module', 'exports', compiled.text)(module, module.exports)
    expect(module.exports.resolved).toMatchObject({
      uri: '/assets/picture.png',
      width: 20,
      height: 30
    })
  }
)
