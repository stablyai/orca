import type { EnvironmentDoctorCheck } from '../../shared/environment-doctor-types'
import { parseOrcaYaml } from '../../shared/orca-yaml'
import {
  check,
  PROBE_TIMEOUT_MS,
  runSafely,
  withOutputTail,
  type EnvironmentDoctorCommandResult,
  type EnvironmentDoctorDeps
} from './environment-doctor-check'
import type { GitCheckoutProbe } from './environment-doctor-git'

// Orca writes .cmd or .sh on Windows depending on the script's shell, so look for both.
const SETUP_RUNNER_NAMES = ['orca/setup-runner.sh', 'orca/setup-runner.cmd'] as const

export async function checkSetup(
  deps: EnvironmentDoctorDeps,
  context: {
    root: string
    runSetup: boolean
    checkout: GitCheckoutProbe
    impliesInstall: boolean
    readRepoFile: (relativePath: string) => Promise<string | null>
  }
): Promise<EnvironmentDoctorCheck[]> {
  const yaml = await context.readRepoFile('orca.yaml')
  const script = yaml ? parseOrcaYaml(yaml)?.scripts.setup?.trim() : undefined
  if (!script) {
    return [
      context.impliesInstall
        ? check('setup', 'setup.script', 'warn', 'orca.yaml has no setup script.', {
            remediation: 'Add scripts.setup to orca.yaml so new workspaces install dependencies.'
          })
        : check('setup', 'setup.script', 'pass', 'No setup script is configured.')
    ]
  }
  if (context.runSetup) {
    const result = await deps
      .runSetupScript({
        worktreePath: context.root,
        rootPath: primaryCheckout(context.root, context.checkout),
        script
      })
      .catch((error: unknown): EnvironmentDoctorCommandResult => ({
        code: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false
      }))
    if (result.code === 0) {
      return [check('setup', 'setup.run', 'pass', 'Setup script ran and exited 0.')]
    }
    return [
      check(
        'setup',
        'setup.run',
        'fail',
        result.timedOut
          ? 'Setup script did not finish in time.'
          : `Setup script exited with code ${result.code ?? 'unknown'}.`,
        { remediation: withOutputTail('Fix scripts.setup in orca.yaml, then re-run.', result) }
      )
    ]
  }
  const launched =
    context.checkout.kind === 'checkout' && (await setupRunnerExists(context.root, deps))
  return [
    launched
      ? check(
          'setup',
          'setup.run',
          'pass',
          'Setup script is configured and has run here. Use --run-setup to check its exit code.'
        )
      : check('setup', 'setup.run', 'warn', 'Setup script is configured but has not run here.', {
          remediation: 'Re-run the doctor with --run-setup to run it and check the result.'
        })
  ]
}

async function setupRunnerExists(root: string, deps: EnvironmentDoctorDeps): Promise<boolean> {
  const result = await runSafely(
    deps,
    'git',
    [
      'rev-parse',
      '--path-format=absolute',
      ...SETUP_RUNNER_NAMES.flatMap((name) => ['--git-path', name])
    ],
    { cwd: root, timeoutMs: PROBE_TIMEOUT_MS }
  )
  if (result.code !== 0) {
    return false
  }
  const paths = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const path of paths) {
    if (await deps.exists(path)) {
      return true
    }
  }
  return false
}

/** ORCA_ROOT_PATH is the primary checkout; a linked worktree's common dir is <primary>/.git. */
function primaryCheckout(root: string, checkout: GitCheckoutProbe): string {
  if (checkout.kind !== 'checkout' || !/[\\/]\.git$/.test(checkout.commonDir)) {
    return root
  }
  return checkout.commonDir.replace(/[\\/]\.git$/, '')
}
