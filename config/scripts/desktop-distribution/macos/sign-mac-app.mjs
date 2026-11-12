import { createRequire } from 'node:module'

// serve-sim launches these with `simctl spawn`, whose DYLD_ROOT_PATH the hardened runtime drops (#40509).
const IOS_SIMULATOR_HELPER_PATHS = [
  '/node_modules/serve-sim/dist/simduo/serve-sim-duo-hid',
  '/node_modules/serve-sim/dist/simax/serve-sim-ax-settings'
]
const IOS_SIMULATOR_HELPER_ENTITLEMENTS = ['com.apple.security.cs.allow-dyld-environment-variables']

export function signMacApp(options, { sign, retry }) {
  const optionsForFile = (filePath, context) => {
    const fileOptions = options.optionsForFile?.(filePath, context)
    return IOS_SIMULATOR_HELPER_PATHS.some((helperPath) => filePath.endsWith(helperPath))
      ? { ...fileOptions, entitlements: IOS_SIMULATOR_HELPER_ENTITLEMENTS }
      : fileOptions
  }
  // A custom signer bypasses electron-builder's retry wrapper.
  return retry(() => sign({ ...options, optionsForFile, batchCodesignCalls: true }), {
    retries: 3,
    interval: 5000,
    backoff: 5000
  })
}

export default async function sign(options) {
  const { sign: signApplication } = await import('@electron/osx-sign')
  const builderRequire = createRequire(createRequire(import.meta.url).resolve('electron-builder'))
  const require = createRequire(builderRequire.resolve('app-builder-lib'))
  const { retry } = require('builder-util')
  const started = performance.now()
  await signMacApp(options, { sign: signApplication, retry })
  console.log(
    `[mac-sign] batched signing completed in ${Math.round(performance.now() - started)}ms`
  )
}
