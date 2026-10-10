/**
 * Why: macOS /etc/zshrc and /etc/bashrc source /etc/{zsh,bash}rc_$TERM_PROGRAM. Under Apple
 * Terminal that script moves HISTFILE into ~/.zsh_sessions and reads unset variables under
 * `nounset`, so a test's real shell would behave differently depending on which terminal app
 * launched the suite.
 */
const HOST_TERMINAL_ENV = ['TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID']
const HOST_TERMINAL_ENV_PREFIX = 'SHELL_SESSION_'

/** A copy of `env` without the launching terminal's identity, for tests that run a real shell. */
export function withoutHostTerminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (!HOST_TERMINAL_ENV.includes(name) && !name.startsWith(HOST_TERMINAL_ENV_PREFIX)) {
      scrubbed[name] = value
    }
  }
  return scrubbed
}
