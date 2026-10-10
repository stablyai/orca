import { prepareAntigravityAccountForLaunch } from '../antigravity/native-account-launch'
import { createAntigravityAccountOperation } from '../antigravity/native-account-operation'
import { pinLocalPtyWslLaunchDistro, type LocalPtyLaunchPlan } from './local-pty-launch-plan'
import type { PtySpawnOptions } from './types'

export async function prepareLocalPtyAntigravityAccount(
  spawn: PtySpawnOptions,
  plan: LocalPtyLaunchPlan,
  env: Record<string, string>,
  signal: AbortSignal
): Promise<void> {
  const parent = spawn.antigravityAccountOperation ?? createAntigravityAccountOperation(signal)
  const prepared = await prepareAntigravityAccountForLaunch({
    launchAgent: spawn.launchAgent,
    command: spawn.command,
    isWsl: plan.isWslShell,
    wslDistro: plan.launchWslDistro,
    env,
    envIsComplete: true,
    envToDelete: spawn.envToDelete,
    operation: { ...parent, signal: AbortSignal.any([parent.signal, signal]) }
  })
  if (!prepared) {
    return
  }
  if (
    !plan.isWslShell ||
    (plan.launchWslDistro &&
      plan.launchWslDistro.toLowerCase() !== prepared.wslDistro.toLowerCase())
  ) {
    throw new Error('The prepared WSL account does not match the terminal execution target')
  }
  pinLocalPtyWslLaunchDistro(plan, spawn, prepared.wslDistro)
}
