import type { WslPreflightTarget } from '../ipc/preflight-wsl-agent-detection'
import {
  execCommandInWslOrThrow,
  execLocalPreflightCommandOrThrow,
  shellQuote
} from '../ipc/preflight-command-exec'

/** Where a forge CLI was found: the WSL guest, or the local copy that passed `--version`. */
export type CliAuthProbe = { wslTarget?: WslPreflightTarget; binary?: string }

// Why the probe object rather than the bare command name: on the local path
// `binary` is the copy that just passed `--version`, which on a shim-shadowed
// host is not what PATH would resolve (#22975). WSL has no `binary` — the guest
// resolves the name inside the distro, where Orca's PATH ordering cannot apply.
export async function isGhAuthenticated(probe: CliAuthProbe): Promise<boolean> {
  try {
    await (probe.wslTarget
      ? execCommandInWslOrThrow(probe.wslTarget, `${shellQuote('gh')} auth status`)
      : execLocalPreflightCommandOrThrow(probe.binary ?? 'gh', ['auth', 'status']))
    // Why: for plain-text `gh auth status`, exit 0 means gh did not detect any
    // authentication issues for the checked hosts/accounts.
    return true
  } catch (error) {
    // Why: some environments may surface partial command output on the thrown
    // error object. Keep a compatibility fallback so we avoid a false auth
    // warning if success markers are present despite a non-zero result.
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in') || output.includes('Active account: true')
  }
}

// Why: parallel to isGhAuthenticated for the glab CLI. glab writes auth
// status to stderr in some versions and stdout in others; check both.
export async function isGlabAuthenticated(probe: CliAuthProbe): Promise<boolean> {
  try {
    await (probe.wslTarget
      ? execCommandInWslOrThrow(probe.wslTarget, `${shellQuote('glab')} auth status`)
      : execLocalPreflightCommandOrThrow(probe.binary ?? 'glab', ['auth', 'status']))
    return true
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in')
  }
}
