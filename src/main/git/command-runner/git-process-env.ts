import { addWslEnvKeys } from '../../wsl-env'
import {
  appendGitConfigEnv,
  gitCredentialPromptGuardEnv
} from '../../../shared/git-credential-prompt-env'
import { UNTRANSLATED_GIT_OUTPUT_ENV } from '../../../shared/git-output-locale'

export function gitOptionalLocksDisabledEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: '0'
  }
}

/**
 * Append git config via the GIT_CONFIG_COUNT/KEY_n/VALUE_n env protocol (git >= 2.31),
 * composing with any count already in `env` so we never clobber a caller's config.
 */
export { appendGitConfigEnv }

/**
 * Pin Orca-spawned git to untranslated English output so stderr/progress parsers
 * work under any user locale (issue #7808). Terminal git is untouched.
 */
export function untranslatedGitOutputEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ...UNTRANSLATED_GIT_OUTPUT_ENV }
}

export function promptGuardGitEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  return gitCredentialPromptGuardEnv(untranslatedGitOutputEnv(env), platform)
}

/**
 * Credential-prompt guard for a general-purpose shell (PTYs, hook scripts):
 * like promptGuardGitEnv but without the issue-7808 locale pins, which would
 * change the locale of every child process, not just git's.
 */
export function promptGuardShellEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  return gitCredentialPromptGuardEnv(env, platform)
}

/**
 * Force git non-interactive so it fails fast instead of hanging on a prompt with
 * no terminal to answer it; on headless `serve` those stuck calls wedge every
 * client (issue #5308).
 *
 * - GIT_TERMINAL_PROMPT=0: git errors instead of prompting for credentials.
 * - GIT_ASKPASS / SSH_ASKPASS: emptied when unset so no GUI helper blocks; a
 *   caller-provided askpass is preserved (custom setups serve creds non-interactively).
 * - GIT_SSH_COMMAND BatchMode=yes: SSH errors instead of prompting (doesn't change
 *   host trust); only added when the caller hasn't set its own.
 */
export function nonInteractiveGitEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const next = promptGuardGitEnv(env, platform)
  if (!next.GIT_SSH_COMMAND) {
    next.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
    if (platform === 'win32') {
      // Why: forward GIT_SSH_COMMAND to WSL only when we set it — a caller's Windows-specific value must not leak into Linux git.
      addWslEnvKeys(next, ['GIT_SSH_COMMAND'])
    }
  }
  return next
}
