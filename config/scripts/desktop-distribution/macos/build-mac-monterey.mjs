import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { getLocalBuildIdentity } from './build-mac-local.mjs'
import { resolvePnpmCliInvocation } from '../../tool-invocation/pnpm-cli-invocation.mjs'
import {
  MONTEREY_LOCAL_ENV,
  isMacMontereyLocalBuild,
  resolveMontereyElectronDistDir
} from './macos-monterey-electron-weak-imports.cjs'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const SWIFT_HELPERS = [
  {
    script: 'config/scripts/native-build/macos/build-keyboard-layout-macos.mjs',
    output: 'native/keyboard-layout-macos/.build/release/orca-keyboard-layout'
  },
  {
    script: 'config/scripts/native-build/macos/build-process-footprint-macos.mjs',
    output: 'native/process-footprint-macos/.build/release/orca-process-footprint'
  },
  {
    script: 'config/scripts/native-build/macos/build-socket-owner-macos.mjs',
    output: 'native/socket-owner-macos/.build/release/orca-socket-owner'
  },
  {
    script: 'config/scripts/native-build/macos/build-notification-status-macos.mjs',
    output: 'native/notification-status-macos/.build/release/orca-notification-status'
  }
]

export function runMacMontereyBuild() {
  if (process.platform !== 'darwin' || process.arch !== 'x64') {
    throw new Error('build:mac:monterey requires macOS x64.')
  }
  const env = { ...process.env, [MONTEREY_LOCAL_ENV]: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  isMacMontereyLocalBuild(env)
  resolveMontereyElectronDistDir(env)

  const pnpm = resolvePnpmCliInvocation()
  const pnpmOptions = { env, shell: pnpm.shell, stdio: 'inherit' }
  execFileSync(pnpm.command, [...pnpm.prefixArgs, 'run', 'build:desktop'], pnpmOptions)
  console.log(
    '[build:mac:monterey] Skipping build:computer-macos (requires macOS 13.4+ / Swift 6).'
  )
  for (const { script, output } of SWIFT_HELPERS) {
    rmSync(resolve(repoRoot, output), { force: true })
    try {
      execFileSync(process.execPath, [resolve(repoRoot, script), '--single-arch'], {
        env,
        stdio: 'inherit'
      })
    } catch (error) {
      console.warn(
        `[build:mac:monterey] Optional helper failed (${script}): ${error?.message ?? error}`
      )
    }
  }
  execFileSync(pnpm.command, [...pnpm.prefixArgs, 'run', 'ensure:electron-runtime'], pnpmOptions)

  const identity = getLocalBuildIdentity()
  console.log(`[build:mac:monterey] local build version ${identity.version}`)
  execFileSync(
    pnpm.command,
    [
      ...pnpm.prefixArgs,
      'exec',
      'electron-builder',
      '--config',
      'config/electron-builder.config.cjs',
      '--mac',
      'dir',
      '--x64',
      '--publish',
      'never'
    ],
    {
      ...pnpmOptions,
      env: {
        ...env,
        ORCA_BUILD_COMMIT: identity.commit,
        ORCA_LOCAL_BUILD_VERSION: identity.version,
        ORCA_REUSE_PREPARED_NATIVE_RUNTIME: '1'
      }
    }
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  runMacMontereyBuild()
}
