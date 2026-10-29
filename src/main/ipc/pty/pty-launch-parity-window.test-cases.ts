import { WINDOW_LAUNCH_CASES } from '../../../shared/launch-parity-window-cases.test-fixture'
import { PLUS_LAUNCH_CASES } from '../../../shared/launch-parity-plus-cases.test-fixture'
import { WORKSPACE_START_LAUNCH_CASES } from '../../../shared/launch-parity-workspace-start-cases.test-fixture'
import {
  windowSpawnRequest,
  type LaunchWorkspace,
  type WindowProviderFacts
} from '../../../shared/launch-parity-window-request.test-fixture'
import {
  AUTOMATION_LAUNCH_CASES,
  automationSpawnRequest
} from '../../../shared/launch-parity-automation-cases.test-fixture'

type WindowLaneCase = {
  label: string
  client: NodeJS.Platform
  workspace: LaunchWorkspace
  settings?: Record<string, unknown>
  request: Record<string, unknown>
  provider: WindowProviderFacts
  env: Record<string, string>
}

export const WINDOW_LANE_CASES: WindowLaneCase[] = [
  ...[...WINDOW_LAUNCH_CASES, ...PLUS_LAUNCH_CASES, ...WORKSPACE_START_LAUNCH_CASES].map((c) => ({
    ...c,
    label: `row ${c.row}: ${c.name}`,
    request: windowSpawnRequest(c),
    env: c.request.agentEnv ?? {}
  })),
  ...AUTOMATION_LAUNCH_CASES.map((c) => ({
    ...c,
    label: `row 5: ${c.name}`,
    request: automationSpawnRequest(c),
    env: {}
  }))
]
