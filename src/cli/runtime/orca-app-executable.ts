import { resolve } from 'node:path'
import { ELECTRON_NO_SANDBOX_REQUEST_ENV } from '../../shared/electron-no-sandbox-request'
import { needsElectronNoSandbox } from './electron-sandbox-switch'
import { serverOnlyServeMessage } from './serve-app-launcher'
import { SERVE_SUPERVISOR_APP_ROOT_ENV } from './serve-supervisor-relocation'
import { RuntimeClientError } from './types'

export function getExecutableAppArgs(executable: string): string[] {
  const args = process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT === '1' ? [resolveAppRoot()] : []
  if (needsElectronNoSandbox(executable)) {
    args.push('--no-sandbox')
  }
  return args
}

export function resolveAppRoot(): string {
  // Pin cwd to the app root; relocated supervisors must also load the app’s own files.
  return process.env[SERVE_SUPERVISOR_APP_ROOT_ENV] || resolve(__dirname, '../../..')
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
