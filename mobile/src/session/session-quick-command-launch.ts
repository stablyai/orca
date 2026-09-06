import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import {
  buildMobileQuickCommandLaunch,
  type MobileQuickCommandLaunch
} from '../terminal/quick-commands'
import type { HostSessionTabOperations } from './host-session-tab-operations'
import type { SessionTabsResult } from './mobile-session-route-types'

type SessionQuickCommandLaunchArgs = {
  nativeClientAvailable: boolean
  connected: boolean
  creatingBrowser: boolean
  creatingMarkdown: boolean
  operations: HostSessionTabOperations | null
  workspaceId: string
  creatingRef: { current: boolean }
  pendingInputByTabId: Map<string, { text: string; enter: false; successToast: string }>
  applySnapshot: (snapshot: SessionTabsResult) => unknown
  setCreating: (creating: boolean) => void
  setCreateError: (message: string) => void
  showErrorFeedback: () => void
  showToast: (message: string, duration?: number) => void
  launchNative: (
    agent: MobileQuickCommandLaunch['agent'],
    options: MobileQuickCommandLaunch['options'] & { errorToast: string }
  ) => void
}

export function createSessionQuickCommandLauncher(
  args: SessionQuickCommandLaunchArgs
): (command: TerminalQuickCommand) => boolean {
  return (command) => {
    const hostedCreate = !args.nativeClientAvailable && Boolean(args.operations?.createQuickCommand)
    if (
      (!args.nativeClientAvailable && !hostedCreate) ||
      !args.connected ||
      args.creatingRef.current ||
      args.creatingBrowser ||
      args.creatingMarkdown
    ) {
      return false
    }
    const launch = buildMobileQuickCommandLaunch(command)
    if (!launch) {
      args.showErrorFeedback()
      args.showToast('Edit this quick command before running it', 1800)
      return false
    }
    const errorToast = `Couldn't run ${command.label.trim() || 'Quick command'}`
    if (hostedCreate && args.operations) {
      void launchHostedSessionQuickCommand({
        ...args,
        command,
        operations: args.operations
      })
    } else {
      args.launchNative(launch.agent, { ...launch.options, errorToast })
    }
    return true
  }
}

async function launchHostedSessionQuickCommand({
  command,
  operations,
  workspaceId,
  creatingRef,
  pendingInputByTabId,
  applySnapshot,
  setCreating,
  setCreateError,
  showErrorFeedback,
  showToast
}: SessionQuickCommandLaunchArgs & {
  command: TerminalQuickCommand
  operations: HostSessionTabOperations
}): Promise<void> {
  const createQuickCommand = operations.createQuickCommand
  if (!createQuickCommand || creatingRef.current) {
    return
  }
  creatingRef.current = true
  setCreating(true)
  setCreateError('')
  try {
    const result = await createQuickCommand(workspaceId, command.id)
    if (result.initialInput) {
      pendingInputByTabId.set(result.tabId, result.initialInput)
    }
    applySnapshot(result.snapshot)
  } catch {
    const message = `Couldn't run ${command.label.trim() || 'Quick command'}`
    setCreateError(message)
    showErrorFeedback()
    showToast(message, 1800)
  } finally {
    creatingRef.current = false
    setCreating(false)
  }
}
