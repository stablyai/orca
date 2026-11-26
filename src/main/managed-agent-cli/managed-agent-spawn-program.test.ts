import { expect, it, vi } from 'vitest'
import { withOmpDraftCleanup } from '../../shared/agent-launch/startup/omp-draft-launch'
import { withFreshOmpLaunch } from '../../shared/agent-launch/startup/omp-fresh-launch'
import { alignManagedAgentLaunchAtSpawn } from './managed-agent-spawn-program'

vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => (process.platform === 'win32' ? 'C:\\data\\orca' : '/data/orca')
}))
const ompGuard = 'printenv ORCA_OMP_FRESH_CONFIG >/dev/null && test -f "$ORCA_OMP_FRESH_CONFIG"'
const ompFailure =
  "printf '%s\\n' 'Orca: fresh OMP settings are unavailable on this host. Restart the terminal after updating Orca.' >&2"

const spawn = (launchCommand: string) =>
  alignManagedAgentLaunchAtSpawn({ launchCommand, getSettings: () => ({}) }, 'posix')

it.skipIf(process.platform === 'win32')(
  'rewrites a saved executable inside the OMP guard',
  async () => {
    const guard = `${ompGuard} || ${ompFailure}; ${ompGuard} && `
    const suffix = ` --config "$ORCA_OMP_FRESH_CONFIG" 'prompt'`
    const saved = `${guard}'/data/orca/agent-runtimes/omp/1.0/bin/omp'${suffix}`
    expect(await spawn(saved)).toBe(`${guard}omp${suffix}`)
    expect(await spawn(withOmpDraftCleanup(saved, 'posix'))).toBe(
      withOmpDraftCleanup(`${guard}omp${suffix}`, 'posix')
    )
  }
)

it.skipIf(process.platform === 'win32')(
  'rewrites the OMP executable with a long prompt',
  async () => {
    const guard = `${ompGuard} || ${ompFailure}; ${ompGuard} && `
    const prompt = ` '${'x'.repeat(5_000)}'`
    const command = withFreshOmpLaunch(
      "'/data/orca/agent-runtimes/omp/1.0/bin/omp'",
      'posix',
      prompt
    )
    expect(await spawn(command)).toBe(`${guard}omp --config "$ORCA_OMP_FRESH_CONFIG"${prompt}`)
  }
)
