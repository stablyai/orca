import { structuredAgentCommandPlan } from '../../shared/agent-launch/startup/tui-agent-launch-command-override'
import {
  classifyDoubaoSignIn,
  type DoubaoSignInStatus
} from '../../shared/agent-launch/installation/doubao-sign-in-status'
import { PROBE_TIMEOUT_MS, runSafely, type EnvironmentDoctorDeps } from './environment-doctor-check'

export async function checkDoubaoSignIn(
  deps: Pick<EnvironmentDoctorDeps, 'run' | 'platform' | 'agentSettings'>,
  cwd: string
): Promise<DoubaoSignInStatus> {
  const command = deps.agentSettings?.agentCmdOverrides?.doubao?.trim() || 'doubao'
  const plan = structuredAgentCommandPlan(
    deps.platform === 'win32' ? command.replace(/^&\s+/, '') : command,
    deps.platform
  )
  if (!plan) {
    return 'unverified'
  }
  return classifyDoubaoSignIn(
    await runSafely(deps, plan.program, [...plan.prefixArgs, 'auth', 'status', '--verify'], {
      cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
      env: { ...deps.agentSettings?.agentDefaultEnv?.doubao, DOUBAO_CLI_NO_UPDATE_CHECK: '1' }
    })
  )
}
