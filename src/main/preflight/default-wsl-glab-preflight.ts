import { admittedDefaultWslCliDistro } from '../git/command-runner/hosted-cli/default-wsl-cli-fallback'
import {
  execCommandInWslOrThrow,
  execLocalPreflightCommandOrThrow,
  isCommandAvailable
} from '../ipc/preflight/preflight-command-exec'
import { buildLocalPreflightEnv } from '../ipc/preflight/preflight-local-env'
import type { PreflightRuntimeContext } from '../ipc/preflight/preflight-runtime-target'
import type { WslPreflightTarget } from '../ipc/preflight/preflight-wsl-agent-detection'
import { withConfiguredProxyEnv } from '../network/configured-proxy-child-env'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'

type GlabStatus = { installed: boolean; authenticated: boolean }

// Same TTL as per-distro preflight entries: a distro can stop, start or gain glab mid-session.
const DEFAULT_WSL_GLAB_TTL_MS = 30_000
const glabByDistro = new Map<string, { glab: GlabStatus; expiresAt: number }>()
const glabInFlight = new Map<string, Promise<GlabStatus>>()
let glabGeneration = 0

/** @internal - tests need a clean cache between cases. */
export function _resetDefaultWslGlabCache(): void {
  glabByDistro.clear()
  glabInFlight.clear()
  glabGeneration += 1
}

/** No workspace picked a runtime, so glab runs as a cwd-less call does: native, else the default distro. */
export function isWindowsHostDefault(context: PreflightRuntimeContext | undefined): boolean {
  return (
    process.platform === 'win32' &&
    !context?.projectRuntime &&
    !context?.wslDistro?.trim() &&
    !context?.wslDefault
  )
}

// glab versions split auth status across stdout/stderr; inspect both.
export async function isGlabAuthenticated(probe: {
  wslTarget?: WslPreflightTarget
  binary?: string
}): Promise<boolean> {
  try {
    await (probe.wslTarget
      ? execCommandInWslOrThrow(probe.wslTarget, `${quotePosixShell('glab')} auth status`)
      : execLocalPreflightCommandOrThrow(probe.binary ?? 'glab', ['auth', 'status'], {
          // `auth status` calls the GitLab API, so it needs the Settings proxy too.
          env: withConfiguredProxyEnv(buildLocalPreflightEnv())
        }))
    return true
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in')
  }
}

async function probeGlabInDistro(distro: string): Promise<GlabStatus> {
  const wslTarget = { distro }
  if (!(await isCommandAvailable('glab', wslTarget))) {
    return { installed: false, authenticated: false }
  }
  return { installed: true, authenticated: await isGlabAuthenticated({ wslTarget }) }
}

/**
 * glab in the distro a cwd-less glab call falls back to, or null when there is none to ask. A stopped
 * distro is never booted for this background read (E9) and is asked again on the next read.
 */
export async function detectDefaultWslGlab(force: boolean): Promise<GlabStatus | null> {
  let distro: string | null
  try {
    distro = await admittedDefaultWslCliDistro()
  } catch {
    return null
  }
  if (!distro) {
    return null
  }
  const now = Date.now()
  for (const [key, entry] of glabByDistro) {
    if (entry.expiresAt <= now) {
      glabByDistro.delete(key)
    }
  }
  if (!force) {
    const hit = glabByDistro.get(distro)?.glab ?? glabInFlight.get(distro)
    if (hit) {
      return hit
    }
  }
  const generation = ++glabGeneration
  const run = probeGlabInDistro(distro)
  glabInFlight.set(distro, run)
  try {
    const glab = await run
    // A newer or reset probe owns the cache; this one only answers its caller.
    if (generation === glabGeneration) {
      glabByDistro.set(distro, { glab, expiresAt: Date.now() + DEFAULT_WSL_GLAB_TTL_MS })
    }
    return glab
  } finally {
    if (glabInFlight.get(distro) === run) {
      glabInFlight.delete(distro)
    }
  }
}
