import { buildPosixFallbackPathPrelude } from '../../shared/posix-version-manager-bin-dirs'
import { runWslProcess } from '../wsl/wsl-runner'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

export type PreflightWslCommandResult = { stdout: string; stderr: string }

export async function runPreflightCommandInWsl(
  target: WslPreflightTarget,
  command: string,
  timeoutMs: number
): Promise<PreflightWslCommandResult> {
  // Use cached login PATH without shell startup banners.
  const result = await runWslProcess({
    distro: target.distro,
    loginPath: 'preferred',
    // Append version-manager fallback directories while keeping resolved login PATH authoritative (#9725).
    script: `${buildPosixFallbackPathPrelude()}\n${command}`,
    timeoutMs
  })
  // Match execFile rejection semantics so callers retain captured output for auth-success fallback.
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
