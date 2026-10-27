import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ARCHITECTURES = [1, 3] // electron-builder: x64, arm64.

export async function buildWithOverlappingNotarization({
  config,
  build,
  notarize,
  verify,
  targets,
  publish,
  credentials,
  log = console.log
}) {
  if (!config.forceCodeSigning || !config.mac?.hardenedRuntime || config.mac.notarize !== true) {
    throw new Error('Overlapping notarization requires the complete macOS release signing policy')
  }
  for (const hook of ['afterSign', 'artifactBuildStarted']) {
    if (config[hook] !== undefined && typeof config[hook] !== 'function') {
      throw new Error(`Unsupported ${hook} hook: expected a function`)
    }
  }
  const tasks = new Map()
  const paths = new Set()
  let aborted = false
  let resolvePrepared
  let rejectPrepared
  const prepared = new Promise((resolve, reject) => {
    resolvePrepared = resolve
    rejectPrepared = reject
  })
  // The first target can be waiting while the second architecture is still signing.
  prepared.catch(() => {})
  const waitForNotarization = async () => {
    await prepared
    const results = await Promise.all(tasks.values())
    const failure = results.find((result) => 'error' in result)
    if (failure) {
      throw failure.error
    }
    if (aborted) {
      throw new Error('macOS packaging was aborted')
    }
  }
  try {
    const artifacts = await build({
      targets,
      publish,
      config: {
        ...config,
        // Only this invocation replaces builder's blocking notary wait with the guarded hooks.
        mac: { ...config.mac, notarize: false },
        concurrency: { ...config.concurrency, jobs: 1 },
        afterSign: async (context) => {
          await config.afterSign?.(context)
          if (context.electronPlatformName !== 'darwin' || !ARCHITECTURES.includes(context.arch)) {
            throw new Error('Unexpected platform or architecture in macOS signing hook')
          }
          const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
          if (tasks.has(context.arch) || paths.has(appPath)) {
            throw new Error('macOS architectures must have separate, freshly signed app bundles')
          }
          paths.add(appPath)
          const task = Promise.resolve()
            .then(async () => {
              log(`[mac-notary] submitting ${appPath}`)
              await notarize({ appPath, ...credentials })
              await verify(appPath)
              log(`[mac-notary] accepted, stapled and verified ${appPath}`)
              return {}
            })
            .catch((error) => {
              rejectPrepared(error)
              return { error }
            })
          tasks.set(context.arch, task)
          if (tasks.size === ARCHITECTURES.length) {
            resolvePrepared()
          }
        },
        artifactBuildStarted: async (event) => {
          if (!ARCHITECTURES.includes(event.arch)) {
            throw new Error('Unexpected architecture in macOS artifact hook')
          }
          await waitForNotarization()
          await config.artifactBuildStarted?.(event)
        }
      }
    })
    if (tasks.size !== ARCHITECTURES.length) {
      throw new Error('Both macOS architectures must be signed before artifacts can succeed')
    }
    await waitForNotarization()
    return artifacts
  } catch (error) {
    aborted = true
    rejectPrepared(error)
    throw error
  } finally {
    // Drain outstanding notary work before a failed invocation returns to retry.
    await Promise.all(tasks.values())
  }
}

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS release packaging requires macOS')
  }
  const publish = args[0] === '--publish' && ['always', 'never'].includes(args[1]) ? args[1] : null
  if (!publish || args.slice(2).some((arg) => arg !== '--draft') || args.length > 3) {
    throw new Error('Usage: build-mac-notarization-overlap.mjs --publish always|never [--draft]')
  }
  const require = createRequire(import.meta.url)
  const { build, Platform, Arch } = require('electron-builder')
  // Use the same pinned notarization implementation as electron-builder, including its retries.
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const { notarize } = createRequire(builderRequire.resolve('app-builder-lib'))(
    '@electron/notarize'
  )
  const config = require('../electron-builder.config.cjs')
  if (args.includes('--draft')) {
    config.publish = { ...config.publish, releaseType: 'draft' }
  }
  const credentials = {
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID
  }
  if (Object.values(credentials).some((value) => !value?.trim())) {
    throw new Error('macOS notarization credentials are incomplete')
  }
  return buildWithOverlappingNotarization({
    config,
    build,
    notarize,
    verify: (appPath) => {
      execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
      execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' })
    },
    targets: new Map([
      [
        Platform.MAC,
        new Map([
          [Arch.x64, ['dmg', 'zip']],
          [Arch.arm64, ['dmg', 'zip']]
        ])
      ]
    ]),
    publish,
    credentials
  })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
