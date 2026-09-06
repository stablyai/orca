import type { RpcClient } from '../transport/rpc-client'
import { activateMobileSessionFileTab } from '../session/mobile-session-file-tab-activation'

type ActivationClient = Pick<RpcClient, 'sendRequest'>

type Options = {
  client: ActivationClient
  worktreeId: string
  relativePath: string
  tabMode: 'diff' | 'edit'
  staged: boolean
  onOpenedFileDiff?: (relativePath: string) => void
  isCurrent?: () => boolean
}

export type MobileSourceControlSessionDiffRevealResult = 'revealed' | 'cancelled' | 'timeout'

export async function revealMobileSourceControlSessionDiff(
  options: Options
): Promise<MobileSourceControlSessionDiffRevealResult> {
  if (options.onOpenedFileDiff) {
    options.onOpenedFileDiff(options.relativePath)
    return 'revealed'
  }

  const result = await activateMobileSessionFileTab(options)
  return result === 'activated' ? 'revealed' : result
}
