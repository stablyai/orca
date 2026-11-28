import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { readZCodeInteractiveCapability } from './interactive-capability'
import { resolveZcodeCliInvocation, type ZcodeCliInvocation } from './zcode-cli-invocation'

export type ZcodeTerminalLaunchAdmission =
  | { status: 'available'; invocation: ZcodeCliInvocation }
  | { status: 'desktop-only' | 'unverified'; invocation: ZcodeCliInvocation }

export async function readZcodeTerminalLaunchAdmission(
  options: {
    commandSettings?: Partial<Pick<GlobalSettings, 'agentCmdOverrides'>>
    pathEnv?: string
  } = {}
): Promise<ZcodeTerminalLaunchAdmission> {
  const invocation = await resolveZcodeCliInvocation(options)
  if (invocation.source === 'desktop-bundle') {
    return { status: 'desktop-only', invocation }
  }
  const capability = await readZCodeInteractiveCapability(options.commandSettings, {
    pathEnv: options.pathEnv
  })
  return capability === 'interactive'
    ? { status: 'available', invocation }
    : { status: 'unverified', invocation }
}

export async function assertZcodeTerminalLaunchAvailable(
  options: {
    commandSettings?: Partial<Pick<GlobalSettings, 'agentCmdOverrides'>>
    pathEnv?: string
  } = {}
): Promise<void> {
  const admission = await readZcodeTerminalLaunchAdmission(options)
  if (admission.status === 'desktop-only') {
    throw new Error(
      'ZCode Desktop does not include the terminal TUI. Use ZCode Chat or install the standalone ZCode CLI.'
    )
  }
  if (admission.status !== 'available') {
    throw new Error(
      'The installed ZCode command could not be verified as a terminal TUI. Reinstall the standalone ZCode CLI or update the zcode Command setting.'
    )
  }
}
