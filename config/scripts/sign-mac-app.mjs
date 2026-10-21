import { createRequire } from 'node:module'

export function signMacApp(options, { sign, retry }) {
  // A custom signer bypasses electron-builder's retry wrapper.
  return retry(() => sign({ ...options, batchCodesignCalls: true }), {
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
