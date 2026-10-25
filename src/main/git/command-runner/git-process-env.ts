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

/** Append Git >= 2.31 config-env entries without overwriting the caller's existing entries. */
export { appendGitConfigEnv }

/** Pin Git diagnostics to English so parsers work under any user locale. */
export function untranslatedGitOutputEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ...UNTRANSLATED_GIT_OUTPUT_ENV }
}

export function promptGuardGitEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  return gitCredentialPromptGuardEnv(untranslatedGitOutputEnv(env), platform)
}

/** Guard PTYs/hooks without locale pins, which would affect every shell child. */
export function promptGuardShellEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  return gitCredentialPromptGuardEnv(env, platform)
}

/** Prevent unattended credential prompts; preserve caller askpass/SSH overrides. */
export function nonInteractiveGitEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const next = promptGuardGitEnv(env, platform)
  if (platform === 'win32') {
    // Decode wsl.exe launch errors as UTF-8 rather than its default UTF-16LE.
    next.WSL_UTF8 = '1'
  }
  if (!next.GIT_SSH_COMMAND && !next.GIT_SSH) {
    next.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
    if (platform === 'win32') {
      // Forward only our SSH override; caller values may be Windows-specific.
      addWslEnvKeys(next, ['GIT_SSH_COMMAND'])
    }
  }
  return next
}
