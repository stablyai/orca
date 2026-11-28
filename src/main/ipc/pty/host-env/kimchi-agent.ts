import { piTitlebarExtensionService } from '../../../pi/managed-extensions/titlebar-extension-service'
import { exposePiManagedExtensionEnv } from './pi-agent'
import { isTuiAgentEnabled } from '../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { PiAgentKind } from '../../../../shared/agent-launch/catalog/pi-agent-kind'
import type { BuildPtyHostEnvOptions } from './types'

export function installKimchiManagedExtensionEnv(
  id: string,
  baseEnv: Record<string, string>,
  opts: BuildPtyHostEnvOptions,
  kind: PiAgentKind,
  explicitKind: PiAgentKind | null,
  sourceAgentDir: string | undefined
): void {
  const shouldInstall =
    opts.agentStatusHooksEnabled && isTuiAgentEnabled('kimchi', opts.disabledTuiAgents)
  if (!shouldInstall || kind !== 'kimchi' || opts.isWsl === true) {
    return
  }
  const managedEnv = piTitlebarExtensionService.buildPtyEnv(id, sourceAgentDir, 'kimchi', {
    materializeDefaultHome: explicitKind === 'kimchi',
    cliOnPath: opts.agentsOnPath?.has('kimchi') === true
  })
  Object.assign(baseEnv, managedEnv)
  exposePiManagedExtensionEnv(baseEnv, 'kimchi', managedEnv)
}
