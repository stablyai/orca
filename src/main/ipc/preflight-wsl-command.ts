import { buildPosixFallbackPathPrelude } from '../../shared/posix-version-manager-bin-dirs'
import { runWslProcess } from '../wsl/wsl-runner'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

export type PreflightWslCommandResult = { stdout: string; stderr: string }

export async function runPreflightCommandInWsl(
  target: WslPreflightTarget,
  command: string,
  timeoutMs: number
): Promise<PreflightWslCommandResult> {
  // Why probe: the cached login PATH gives the user's real nvm/mise/asdf PATH
  // with no shell in the loop, so there is no rc/motd banner to strip.
  const result = await runWslProcess({
    distro: target.distro,
    loginPath: 'preferred',
    // Appending the version-manager dirs keeps a resolved login PATH
    // authoritative while stopping a degraded probe from turning an installed
    // CLI into "not installed" (#9725), the same fallback the native branch has.
    script: `${buildPosixFallbackPathPrelude()}\n${command}`,
    timeoutMs
  })
  // runWslProcess resolves on a timeout and on a non-zero exit; the caller's
  // try/catch (isCommandAvailable/isCommandOnPath, and isGhAuthenticated's
  // stdout/stderr marker fallback) expects a rejection carrying stdout/stderr,
  // matching what execFile's promisified callback put on a non-zero-exit error.
  if (result.timedOut || result.code !== 0) {
    throw Object.assign(new Error(`WSL command failed: ${command}`), {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut
    })
  }
  return { stdout: result.stdout, stderr: result.stderr }
}
