import {
  type resolveTerminalLaunchResult,
  terminalLaunchPublicFacts
} from './terminal-launch-result'
import { revealCreatedTerminal } from './terminal-create-reveal'

import type * as dependencies from '../../orca-runtime-create-terminal-dependencies'

export function prepareTerminalCreateCompletion(args: {
  notifier: Parameters<typeof revealCreatedTerminal>[0]['notifier']
  workspace: Parameters<typeof revealCreatedTerminal>[0]['workspace']
  result: Parameters<typeof terminalLaunchPublicFacts>[0]
  pty: Parameters<typeof terminalLaunchPublicFacts>[2]
  launch: ReturnType<typeof resolveTerminalLaunchResult>
  launchOpts: dependencies.TerminalCreateOptions
  presentation: Parameters<typeof revealCreatedTerminal>[0]['presentation']
  opts: dependencies.TerminalCreateOptions
  tabId: string
  leafId: string
  paneKey: string
  handle: string
  savedStartupCwd: string
  executionMetadata: () => Pick<
    dependencies.RuntimeTerminalCreate,
    'executionHostId' | 'hostPlatform' | 'incarnationId'
  >
}) {
  const {
    notifier,
    workspace,
    result,
    pty,
    launch,
    launchOpts,
    presentation,
    opts,
    tabId,
    leafId,
    paneKey,
    handle,
    savedStartupCwd,
    executionMetadata
  } = args
  const reveal = revealCreatedTerminal({
    notifier,
    workspace,
    ptyId: result.id,
    handle,
    cwd: savedStartupCwd,
    launchOpts: {
      ...launchOpts,
      title: pty?.title ?? launch.effectiveTitle ?? undefined,
      launchAgent: pty?.launchAgent ?? undefined,
      viewMode: launch.effectiveViewMode
    },
    effectiveLaunchConfig: pty?.launchConfig ?? undefined,
    launchToken: pty?.launchToken ?? undefined,
    adoptedStablePane: launch.adoptedStablePane,
    presentation,
    opts,
    tabId,
    leafId
  })

  return {
    reveal,
    result: ({ surface, warning }: Awaited<ReturnType<typeof revealCreatedTerminal>>) => {
      return {
        ...terminalLaunchPublicFacts(result, launch.adoptedStablePane, pty),
        handle,
        savedStartupCwd,
        tabId,
        paneKey,
        ptyId: result.id,
        worktreeId: workspace.id,
        title: pty?.title ?? launch.effectiveTitle ?? null,
        ...executionMetadata(),
        surface,
        ...(result.startupCwdFallback ? { startupCwdFallback: result.startupCwdFallback } : {}),
        ...(warning ? { warning } : {})
      }
    }
  }
}
