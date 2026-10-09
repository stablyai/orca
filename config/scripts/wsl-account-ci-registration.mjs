import { hasWslSourceChange } from './pr-e2e-source-routing.mjs'

export const WSL_ACCOUNT_TEST_PATH = 'src/main/antigravity/native-wsl-accounts.wsl.test.ts'

export function isRegisteredInWslAccountLane(path, pr, workflow) {
  if (path !== WSL_ACCOUNT_TEST_PATH || !hasWslSourceChange([path])) {
    return false
  }
  const caller = pr.jobs?.windows_wsl
  const job = workflow.jobs?.['wsl-terminal']
  if (
    caller?.uses !== './.github/workflows/windows-wsl-e2e.yml' ||
    caller.needs !== 'code_paths' ||
    caller.if !== "needs.code_paths.outputs.wsl_source_changed == 'true'" ||
    caller.with?.ref !== '${{ github.event.pull_request.head.sha }}' ||
    job?.['runs-on'] !== 'windows-2022' ||
    job.if !== undefined ||
    job['continue-on-error'] ||
    job.env?.ORCA_BACKGROUND_LAUNCH !== '1'
  ) {
    return false
  }
  const steps = job.steps ?? []
  const exerciseIndex = steps.findIndex((step) => step.id === 'wsl-accounts')
  const exercise = steps[exerciseIndex]
  const receiptIndex = steps.findIndex(
    (step) => step.name === 'Require both WSL account executions'
  )
  const receipt = steps[receiptIndex]
  const setupIndex = steps.findIndex(
    (step) => step.uses === './.github/actions/setup-wsl-test-runtime'
  )
  const argv = String(exercise?.run ?? '').split(/\s+/)
  return (
    setupIndex !== -1 &&
    setupIndex < exerciseIndex &&
    steps[setupIndex].with?.['second-distro'] === 'true' &&
    steps[0]?.with?.ref === '${{ inputs.ref || github.sha }}' &&
    exercise.if === undefined &&
    !exercise['continue-on-error'] &&
    exercise.env?.ORCA_REAL_ANTIGRAVITY_WSL_ACCOUNTS_TEST === '1' &&
    exercise.env?.ORCA_WSL_TEST_DISTRO === 'Ubuntu' &&
    exercise.env?.ORCA_WSL_SECOND_TEST_DISTRO === 'Ubuntu-Secondary' &&
    argv.slice(0, 4).join(' ') === 'pnpm exec vitest run' &&
    argv.includes(path) &&
    argv.includes('--reporter=json') &&
    argv.includes('--outputFile=test-results/wsl-accounts.json') &&
    receiptIndex > exerciseIndex &&
    receipt?.if === "${{ !cancelled() && steps.wsl-accounts.outcome != 'skipped' }}" &&
    !receipt['continue-on-error'] &&
    receipt.run ===
      'node config/scripts/verify-wsl-account-participation.mjs test-results/wsl-accounts.json'
  )
}
