import { useEffect, useState } from 'react'
import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import {
  BUILT_IN_WINDOWS_TERMINAL_SHELLS,
  type BuiltInWindowsTerminalShell
} from '../../../../../src/shared/shell/launch/windows-terminal-shell'

// A shell this build can't name is dropped rather than failing the whole answer.
const terminalShellChoicesSchema = z.object({
  shells: z
    .array(z.unknown())
    .transform((shells) =>
      shells.filter((shell): shell is BuiltInWindowsTerminalShell =>
        BUILT_IN_WINDOWS_TERMINAL_SHELLS.some((known) => known === shell)
      )
    )
})

const NO_SHELL_CHOICES: readonly BuiltInWindowsTerminalShell[] = []

export const terminalShellChoicesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.tabs.terminal-shell-choices',
    method: 'session.tabs.terminalShellChoices',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-shell-choices', terminalShellChoicesSchema)
  })
)

/**
 * The host's answer to which of desktop's Windows shell entries it would start in this workspace,
 * default first; empty off Windows, over SSH, or when the host can't say.
 */
export function useMobileWindowsShellChoices({
  client,
  enabled,
  sheetOpen,
  worktreeId
}: {
  client: RpcClient | null
  enabled: boolean
  /** Ask again each time the New Tab sheet opens, so the answer follows the project's runtime. */
  sheetOpen: boolean
  worktreeId: string
}): readonly BuiltInWindowsTerminalShell[] {
  const [read, setRead] = useState<{
    key: string
    client: RpcClient
    shells: readonly BuiltInWindowsTerminalShell[]
  } | null>(null)

  useEffect(() => {
    if (!client || !enabled || !sheetOpen) {
      return
    }
    let stale = false
    void terminalShellChoicesRead
      .request(client, { worktree: `id:${worktreeId}` })
      .then((response) => {
        const answer = terminalShellChoicesRead.interpret(response)
        if (!stale && answer.accepted) {
          setRead({ key: worktreeId, client, shells: answer.value.shells })
        }
      })
      .catch(() => {
        // Keep the single Terminal action when the host can't answer.
      })
    return () => {
      stale = true
    }
  }, [client, enabled, sheetOpen, worktreeId])

  return enabled && read?.client === client && read.key === worktreeId
    ? read.shells
    : NO_SHELL_CHOICES
}
