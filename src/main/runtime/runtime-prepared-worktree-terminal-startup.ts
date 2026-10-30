import type {
  startRuntimeLocalWorktreeTerminals,
  RuntimeLocalWorktreeTerminalStartupResult
} from './runtime-local-worktree-terminal-startup'
import { paneIdentity } from './runtime-terminal-pane-identity'
import type { WorktreeTerminalProvisioningArgs } from './runtime-worktree-terminal-provisioning'

export async function startPreparedLocalWorktreeTerminals(
  args: Parameters<typeof startRuntimeLocalWorktreeTerminals>[0],
  provisionArgs: WorktreeTerminalProvisioningArgs
): Promise<RuntimeLocalWorktreeTerminalStartupResult | null> {
  const { request, repo, worktree, defaultTabs, startup, ports, setup } = args
  const shouldActivate = request.activate === true || request.runHooks === true
  const warning = args.warning
  if (
    startup &&
    request.preparedAgentLaunch &&
    ports.canSpawn &&
    ports.startPrepared &&
    args.createdWithAgent &&
    !(args.startupLaunchRuntime instanceof Error)
  ) {
    const first = defaultTabs?.tabs[0]
    const prepared = await ports.startPrepared(
      {
        command: startup.command,
        env: startup.env,
        launchConfig: startup.launchConfig,
        launchAgent: args.createdWithAgent,
        launchRuntime: args.startupLaunchRuntime,
        ...paneIdentity(request.startupPaneKey),
        ...(request.startupCwd ? { cwd: request.startupCwd } : {}),
        ...(first?.title ? { title: first.title } : {}),
        viewMode: startup.viewMode,
        startupCommandDelivery: startup.startupCommandDelivery,
        telemetry: startup.telemetry,
        ...(shouldActivate ? {} : { surfaceOwner: false as const })
      },
      {
        ...(args.draftPaste ? { draft: args.draftPaste } : {}),
        ...(args.startupFollowup ? { followup: args.startupFollowup } : {})
      }
    )
    if (prepared) {
      // The first template belongs to the eventual agent; extras run once while Setup is interactive.
      const provisioned = await ports.provision({
        ...provisionArgs,
        setup: setup?.waitForAgentStartup ? undefined : setup,
        ...(defaultTabs
          ? { defaultTabs: { ...defaultTabs, tabs: defaultTabs.tabs.slice(1) } }
          : {}),
        ...(ports.provisionInBackground?.() || !shouldActivate
          ? { surfaceOwner: false as const }
          : {})
      })
      if (shouldActivate) {
        ports.activate(repo.id, worktree.id)
      }
      return {
        ...(warning ? { warning } : {}),
        pendingStartup: prepared.pending,
        didSpawnSetup: setup?.waitForAgentStartup === true || provisioned.setupSpawned,
        didSpawnStartup: false,
        setupTerminalHandle:
          prepared.setupTerminal?.handle ??
          prepared.pending.setupTerminalHandle ??
          provisioned.setupTerminalHandle,
        startupTerminalHandle: null,
        startupTerminalTabId: null,
        startupTerminalPaneKey: null,
        startupTerminalPtyId: null
      }
    }
  }
  return null
}
