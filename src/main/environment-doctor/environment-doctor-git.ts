import type { EnvironmentDoctorCheck } from '../../shared/environment-doctor-types'
import {
  check,
  PROBE_TIMEOUT_MS,
  runSafely,
  withOutputTail,
  type EnvironmentDoctorCommandResult,
  type EnvironmentDoctorDeps
} from './environment-doctor-check'

const NETWORK_TIMEOUT_MS = 20_000
// dry-run never writes refs, so this name exists only to avoid non-fast-forward noise.
const PUSH_PROBE_REF = 'refs/heads/orca-env-doctor-push-probe'

export type GitCheckoutProbe =
  | { kind: 'checkout'; root: string; commonDir: string }
  | { kind: 'not-checkout' }
  | { kind: 'error'; result: EnvironmentDoctorCommandResult }

type GitRunner = (args: string[], timeoutMs?: number) => Promise<EnvironmentDoctorCommandResult>

function gitRunner(cwd: string, deps: EnvironmentDoctorDeps): GitRunner {
  return (args, timeoutMs = PROBE_TIMEOUT_MS) =>
    runSafely(deps, 'git', args, { cwd, timeoutMs, guardGitPrompts: true })
}

/** One rev-parse resolves the checkout root, so a doctor started in a subfolder reads the repo's files. */
export async function probeGitCheckout(
  path: string,
  deps: EnvironmentDoctorDeps
): Promise<GitCheckoutProbe> {
  const result = await gitRunner(
    path,
    deps
  )([
    'rev-parse',
    '--is-inside-work-tree',
    '--show-toplevel',
    '--path-format=absolute',
    '--git-common-dir'
  ])
  if (result.code === 0) {
    const [inside, root, commonDir] = result.stdout.split(/\r?\n/).map((line) => line.trim())
    return inside === 'true' && root && commonDir
      ? { kind: 'checkout', root, commonDir }
      : { kind: 'not-checkout' }
  }
  // Folder workspaces are valid; anything else (dubious ownership, a broken repo) must surface.
  return /not a git repository/i.test(result.stderr)
    ? { kind: 'not-checkout' }
    : { kind: 'error', result }
}

export async function checkGit(
  probe: GitCheckoutProbe,
  deps: EnvironmentDoctorDeps
): Promise<EnvironmentDoctorCheck[]> {
  if (probe.kind === 'not-checkout') {
    return [check('git', 'git.repo', 'pass', 'Not a Git checkout; Git checks skipped.')]
  }
  if (probe.kind === 'error') {
    return [
      check('git', 'git.repo', 'fail', 'Git cannot read this checkout.', {
        remediation: withOutputTail('Fix the repository before agents use it.', probe.result)
      })
    ]
  }
  const git = gitRunner(probe.root, deps)
  const remote = await resolvePushRemote(git)
  if (!remote) {
    return [
      check('git', 'git.remote', 'warn', 'No Git remote is configured.', {
        remediation: 'Add a remote (git remote add origin <url>) so agents can push their work.'
      })
    ]
  }
  const [fetch, head] = await Promise.all([
    git(['ls-remote', remote, 'HEAD'], NETWORK_TIMEOUT_MS),
    git(['rev-parse', '--verify', '--quiet', 'HEAD'])
  ])
  if (fetch.code !== 0) {
    // A fetch failure already explains why a push would fail.
    return [
      check('git', 'git.fetch', 'fail', `Cannot reach remote "${remote}".`, {
        remediation: withOutputTail(
          'Check network access and Git credentials for this environment.',
          fetch
        )
      })
    ]
  }
  const checks = [check('git', 'git.fetch', 'pass', `Remote "${remote}" is reachable.`)]
  if (head.code !== 0) {
    checks.push(
      check('git', 'git.push', 'warn', 'No commits yet, so push access was not checked.', {
        remediation: 'Commit once, then re-run the doctor.'
      })
    )
    return checks
  }
  const push = await git(
    ['push', '--dry-run', '--no-verify', '--porcelain', remote, `HEAD:${PUSH_PROBE_REF}`],
    NETWORK_TIMEOUT_MS
  )
  checks.push(
    push.code === 0
      ? check('git', 'git.push', 'pass', `Push to "${remote}" is authorized (dry run).`)
      : check('git', 'git.push', 'fail', `A dry-run push to "${remote}" was refused.`, {
          remediation: withOutputTail(
            'Give this environment a Git credential with write access to the repo.',
            push
          )
        })
  )
  return checks
}

/** Where `git push` would go: pushRemote, then pushDefault, then the upstream remote, then origin. */
async function resolvePushRemote(git: GitRunner): Promise<string | null> {
  const config = async (key: string): Promise<string | null> => {
    const result = await git(['config', '--get', key])
    const value = result.stdout.trim()
    return result.code === 0 && value && value !== '.' ? value : null
  }
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const name = branch.code === 0 ? branch.stdout.trim() : ''
  const configured =
    (name ? await config(`branch.${name}.pushRemote`) : null) ??
    (await config('remote.pushDefault')) ??
    (name ? await config(`branch.${name}.remote`) : null)
  if (configured) {
    return configured
  }
  const remotes = await git(['remote'])
  const names = remotes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return names.includes('origin') ? 'origin' : (names[0] ?? null)
}
