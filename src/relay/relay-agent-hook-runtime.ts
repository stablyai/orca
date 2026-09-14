import type { RelayDispatcher } from './dispatcher'
import type { PtyEnvAugmenter, PtyHandler } from './pty-handler'
import { RelayAgentHookServer } from './agent-hook-server'
import { endpointDirForRelaySocket } from './agent-hook-endpoint-coordinates'
import { PluginOverlayManager } from './plugin-overlay'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../shared/agent-hook-relay'
import { publishAgentHookEnvelope } from './agent-hook-envelope-publication'
import { assertPluginSourceUnderByteCap } from './plugin-source-limit'
import { resolveOpenCodeSourceConfigDir, resolvePiSourceAgentDir } from './plugin-overlay-env'
import {
  detectExplicitPiAgentKindFromCommand,
  isPiCompatibleAgentType
} from '../shared/pi-agent-kind'
import { resolveSetupAgentSequenceLaunchCommand } from '../shared/setup-agent-sequencing'
import { relayLogLine } from './relay-diagnostic-log'
import { registerManagedHookInstaller } from './managed-hook-installer'

export class RelayAgentHookRuntime {
  private readonly hookServer: RelayAgentHookServer
  private readonly pluginOverlay = new PluginOverlayManager()

  constructor(
    private readonly dispatcher: RelayDispatcher,
    private readonly ptyHandler: PtyHandler,
    sockPath: string,
    endpointDir?: string
  ) {
    this.hookServer = new RelayAgentHookServer({
      endpointDir: endpointDir ?? endpointDirForRelaySocket(sockPath),
      forward: (envelope) => publishAgentHookEnvelope(dispatcher, envelope),
      // Why: the PTY handler is the only component that knows which panes still have a client
      // surface, so it — not the client — decides whether a hook post describes a live pane.
      isPaneSurfaceRetired: (paneKey) => ptyHandler.isPaneSurfaceRetired(paneKey)
    })
  }

  async start(): Promise<void> {
    try {
      await this.hookServer.start({ publishEndpoint: false })
    } catch (error) {
      relayLogLine(
        `[relay] agent-hook server failed to start: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    this.registerPtyEnvironment()
    this.registerHandlers()
  }

  publishEndpointFile(): void {
    this.hookServer.publishEndpointFile()
  }

  stop(): void {
    this.hookServer.stop()
  }

  private registerPtyEnvironment(): void {
    this.ptyHandler.addEnvAugmenter(() => this.hookServer.buildPtyEnv())
    this.ptyHandler.addEnvAugmenter((context) => this.buildPluginEnvironment(context))
    this.ptyHandler.setExitListener(({ paneKey, id }) => {
      if (paneKey) {
        this.hookServer.clearPaneState(paneKey)
      }
      this.pluginOverlay.clearOverlay(paneKey ?? id)
    })
    // Why: the exit listener above only fires on proof of process death, which a shell that
    // survives teardown never produces. Drop the pane's cached status the moment its tab goes, so a
    // reconnecting client cannot be handed a replay of an agent nobody owns.
    this.ptyHandler.setSurfaceRetiredListener(({ paneKey }) => {
      this.hookServer.clearPaneState(paneKey)
    })
  }

  private buildPluginEnvironment(context: Parameters<PtyEnvAugmenter>[0]): Record<string, string> {
    const env: Record<string, string> = {}
    const overlayId = context.paneKey ?? context.id
    if (this.pluginOverlay.hasOpenCodeSource()) {
      const sourceDir = resolveOpenCodeSourceConfigDir(context.env, context.shell)
      const dir = this.pluginOverlay.materializeOpenCode(overlayId, sourceDir)
      if (dir) {
        env.OPENCODE_CONFIG_DIR = dir
        env.ORCA_OPENCODE_CONFIG_DIR = dir
        if (sourceDir) {
          env.ORCA_OPENCODE_SOURCE_CONFIG_DIR = sourceDir
        }
      }
    }
    if (!this.pluginOverlay.hasPiSource()) {
      return env
    }
    const launchCommandHint = resolveSetupAgentSequenceLaunchCommand(context.env, context.command)
    const explicitKind = isPiCompatibleAgentType(context.launchAgent)
      ? context.launchAgent
      : context.launchAgent === undefined
        ? detectExplicitPiAgentKindFromCommand(launchCommandHint)
        : null
    const kind = explicitKind ?? 'pi'
    const hasLaunchCommand =
      typeof launchCommandHint === 'string' && launchCommandHint.trim().length > 0
    if (kind === 'pi') {
      const sourceDir = resolvePiSourceAgentDir(context.env, context.shell, 'pi')
      const result = this.pluginOverlay.materializePi(overlayId, sourceDir, 'pi', {
        materializeDefaultHome: explicitKind === 'pi'
      })
      if (result?.sourceAgentDir) {
        env.ORCA_PI_SOURCE_AGENT_DIR = result.sourceAgentDir
      }
    }
    if (kind === 'omp' || !hasLaunchCommand) {
      const sourceDir =
        kind === 'omp'
          ? resolvePiSourceAgentDir(context.env, context.shell, 'omp')
          : context.env.ORCA_OMP_SOURCE_AGENT_DIR
      const result = this.pluginOverlay.materializePi(overlayId, sourceDir, 'omp', {
        materializeDefaultHome: explicitKind === 'omp'
      })
      if (result?.statusExtensionPath) {
        env.ORCA_OMP_STATUS_EXTENSION = result.statusExtensionPath
      }
      if (result?.sourceAgentDir) {
        env.ORCA_OMP_SOURCE_AGENT_DIR = result.sourceAgentDir
      }
    }
    if (kind === 'prime-agent') {
      const sourceDir = resolvePiSourceAgentDir(context.env, context.shell, 'prime-agent')
      const result = this.pluginOverlay.materializePi(overlayId, sourceDir, 'prime-agent', {
        materializeDefaultHome: explicitKind === 'prime-agent'
      })
      if (result?.sourceAgentDir) {
        env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR = result.sourceAgentDir
      }
    }
    return env
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => ({
      replayed: this.hookServer.replayCachedPayloadsForPanes()
    }))
    registerManagedHookInstaller(this.dispatcher)
    this.dispatcher.onRequest(AGENT_HOOK_INSTALL_PLUGINS_METHOD, async (params) => {
      const opencode = params.opencodePluginSource
      const pi = params.piExtensionSource
      const omp = params.ompExtensionSource
      const primeAgent = params.primeAgentExtensionSource
      assertPluginSourceUnderByteCap('opencodePluginSource', opencode)
      assertPluginSourceUnderByteCap('piExtensionSource', pi)
      assertPluginSourceUnderByteCap('ompExtensionSource', omp)
      assertPluginSourceUnderByteCap('primeAgentExtensionSource', primeAgent)
      this.pluginOverlay.setSources({
        opencodePluginSource: typeof opencode === 'string' ? opencode : undefined,
        piExtensionSource: typeof pi === 'string' ? pi : undefined,
        ompExtensionSource: typeof omp === 'string' ? omp : undefined,
        primeAgentExtensionSource: typeof primeAgent === 'string' ? primeAgent : undefined
      })
      return {
        installed: {
          opencode: this.pluginOverlay.hasOpenCodeSource(),
          pi: this.pluginOverlay.hasPiSource('pi'),
          omp: this.pluginOverlay.hasPiSource('omp'),
          primeAgent: this.pluginOverlay.hasPiSource('prime-agent')
        }
      }
    })
  }
}
