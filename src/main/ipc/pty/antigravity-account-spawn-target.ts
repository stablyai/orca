import { prepareAntigravityAccountForLaunch } from '../../antigravity/native-account-launch'
import type { CodexAccountSelectionTarget } from '../../codex-accounts/runtime-selection'

export async function prepareAntigravityPtySpawnTarget(
  ctx: {
    expectedWslDistro: string | null
    terminalRuntimeOptions: { terminalWindowsWslDistro?: string | null }
    codexSelectionTarget: CodexAccountSelectionTarget
  },
  args: Parameters<typeof prepareAntigravityAccountForLaunch>[0]
): Promise<void> {
  const prepared = await prepareAntigravityAccountForLaunch(args)
  if (!prepared) {
    return
  }
  ctx.expectedWslDistro = prepared.wslDistro
  ctx.terminalRuntimeOptions.terminalWindowsWslDistro = prepared.wslDistro
  ctx.codexSelectionTarget = { runtime: 'wsl', wslDistro: prepared.wslDistro }
}
