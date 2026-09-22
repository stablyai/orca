import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { zcodeHookService } from '../zcode/hook-service'

export function getZcodeHookStatus(): AgentHookInstallStatus {
  try {
    return zcodeHookService.getStatus()
  } catch (error) {
    return {
      agent: 'zcode',
      state: 'error',
      configPath: '',
      managedHooksPresent: false,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}
