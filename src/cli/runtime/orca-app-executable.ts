import { mkdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { ELECTRON_NO_SANDBOX_REQUEST_ENV } from '../../shared/app-lifecycle/launch/electron-no-sandbox-request'
import { needsElectronNoSandbox } from './app-launch/electron-sandbox-switch'
import { serverOnlyServeMessage } from './app-launch/serve-app-launcher'
import {
  PACKAGED_APP_ROOT_NAME,
  SERVE_SUPERVISOR_APP_ROOT_ENV
} from './serve/supervision/serve-supervisor-relocation'
import { RuntimeClientError } from './connection/types'

export function getExecutableAppArgs(executable: string): string[] {
  const args = process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT === '1' ? [resolveAppRoot()] : []
  if (needsElectronNoSandbox(executable)) {
    args.push('--no-sandbox')
  }
  return args
}

export function resolveAppRoot(): string {
  // Relocated supervisors run from a copy, so the env var names the installed app's root.
  return process.env[SERVE_SUPERVISOR_APP_ROOT_ENV] || resolve(__dirname, '../../..')
}

/** Packaged apps run from the profile: reinstalling deletes the bundle cwd, and Node workers then fail with uv_cwd. */
export function resolveAppChildCwd(userDataPath: string): string {
  const appRoot = resolveAppRoot()
  // Dev keeps the app root because its resource resolution may consult process.cwd().
  if (basename(appRoot) !== PACKAGED_APP_ROOT_NAME) {
    return appRoot
  }
  try {
    // A first serve on a fresh host can precede Electron creating the profile.
    mkdirSync(userDataPath, { recursive: true, mode: 0o700 })
    return userDataPath
  } catch {
    return appRoot
  }
}

export function resolveForegroundOrcaExecutable(): string {
  const overrideExecutable = process.env.ORCA_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    return overrideExecutable
  }
  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    return process.execPath
  }
  throw new RuntimeClientError('runtime_serve_failed', serverOnlyServeMessage(process.platform))
}

export function stripElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.ELECTRON_RUN_AS_NODE
  // The switch applies only to app launch; terminals must not inherit the request.
  delete next[ELECTRON_NO_SANDBOX_REQUEST_ENV]
  // Only the relocated supervisor may override its app root.
  delete next[SERVE_SUPERVISOR_APP_ROOT_ENV]
  return next
}
