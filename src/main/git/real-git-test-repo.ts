import { execFileSync } from 'node:child_process'

export type RealGitTestIdentity = { name: string; email: string }

/**
 * Why: tests must neither depend on nor use the developer's signing setup. A global
 * `commit.gpgsign` signs fixture commits with the developer's own key, and `tag.gpgsign` turns
 * `git tag <name>` into a signed annotated tag that fails without a message. Overriding just these
 * keeps everything else the host's Git needs (`safe.directory`, Git for Windows' system config).
 */
const REAL_GIT_TEST_SETTINGS = [
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false']
] as const

/** The same settings as `-c` arguments, for a command in a checkout the fixture did not
 *  configure itself, such as a submodule or a clone made by the code under test. */
export const REAL_GIT_TEST_CONFIG_ARGS = REAL_GIT_TEST_SETTINGS.flatMap(([key, value]) => [
  '-c',
  `${key}=${value}`
])

/**
 * Writes the settings into a fixture repo's own config, which outranks the global one. Call it
 * right after `git init`, and again on any clone the fixture commits or tags in.
 */
export function configureRealGitTestRepo(repo: string, identity?: RealGitTestIdentity): void {
  const entries: (readonly [string, string])[] = [...REAL_GIT_TEST_SETTINGS]
  if (identity) {
    entries.push(['user.name', identity.name], ['user.email', identity.email])
  }
  for (const [key, value] of entries) {
    execFileSync('git', ['config', key, value], { cwd: repo, stdio: 'ignore' })
  }
}
