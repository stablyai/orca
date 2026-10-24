/**
 * The Claude/Codex accounts this server owns, so `accounts.*` and the launches it starts use the
 * account selected here, as desktop `orca serve` did (#28962).
 */
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  GetSelectedCodexHomePath,
  PrepareClaudeAuth,
  PrepareCodexSessionResume
} from '../ipc/pty/host-env/types'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { createProviderAccountServices } from '../provider-account-services'
import { createCodexRuntimeHomeLaunchPreparation } from '../codex/codex-runtime-home-launch-preparation'
import { createCodexSessionResumeLaunchPreparation } from '../codex/codex-session-resume-launch-preparation'
import { prepareCodexAiVaultSessionResume } from '../codex/codex-ai-vault-session-resume'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { resolveHostAgentBaseEnvironment } from '../runtime/structured-agent-shell-environment'
import { isWslHostOrcadProcess } from '../ipc/wsl-guest-windows-drive-path'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

type StructuredLaunchInput = { launchEnv: NodeJS.ProcessEnv }

type OrcadAccountServices = {
  prepareCodexHome: ReturnType<typeof createCodexRuntimeHomeLaunchPreparation>
  prepareClaudeAuth: PrepareClaudeAuth
  /** Pins an automatic resume to the account home its session was recorded in. */
  prepareCodexSessionResume: PrepareCodexSessionResume
  /** Runtime constructor deps: structured chats and catalog reads follow this host's Codex selection. */
  runtimeDeps: {
    prepareCodexStructuredLaunch: (input: StructuredLaunchInput) => Promise<string | null>
    resolveCodexStructuredLaunchHome: (input: StructuredLaunchInput) => string | null
    prepareCodexCatalogProbeHome: (homePath: string) => void
    prepareAiVaultSessionResume: (
      args: AiVaultPrepareSessionResumeArgs
    ) => Promise<AiVaultPrepareSessionResumeResult>
  }
  /** The managed Codex homes this host's launches write sessions into. */
  listCodexSessionHomes: () => string[]
  attachToRuntime: (
    runtime: Pick<
      OrcaRuntimeService,
      'setAccountServices' | 'setCommitMessageAgentEnvironmentResolvers'
    >
  ) => void
}

/** Null on a WSL host, whose runtime must keep the desktop-pushed CODEX_HOME (no structured resolvers). */
export function createOrcadAccountServices(args: {
  store: Store
  setClaudeStatusLineListener: (
    listener: ((event: ClaudeStatusLineRateLimits) => void) | null
  ) => void
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
  /** A client-sent account home (launch env CODEX_HOME) wins over this host's selection, as for PTYs. */
  clientCodexHomes: {
    selectLaunchHome: GetSelectedCodexHomePath
    readLaunchHome: (launchEnv?: NodeJS.ProcessEnv) => string | null
  }
  isWslHost?: () => boolean
}): OrcadAccountServices | null {
  // Why: the Windows desktop owns a WSL host's accounts and pushes them (accounts.setHostLaunchEnv),
  // which a host with services of its own refuses.
  if ((args.isWslHost ?? isWslHostOrcadProcess)()) {
    return null
  }
  const { store, clientCodexHomes } = args
  const services = createProviderAccountServices(store, {
    setClaudeStatusLineListener: args.setClaudeStatusLineListener
  })
  // Why no start(): like headless desktop serve, usage refreshes on demand (accounts.list, subscribe).
  args.registerCleanup(() => {
    services.rateLimits.stop()
    args.setClaudeStatusLineListener(null)
  })
  const { codexRuntimeHome } = services
  const prepareCodexHome = createCodexRuntimeHomeLaunchPreparation({
    getRuntimeHome: () => codexRuntimeHome,
    getSettings: () => store.getSettings()
  })
  const prepareClaudeAuth: PrepareClaudeAuth = (target) =>
    services.claudeRuntimeAuth.prepareForClaudeLaunch(target)
  const resumeLaunch = createCodexSessionResumeLaunchPreparation({
    getRuntimeHome: () => codexRuntimeHome,
    getSettings: () => store.getSettings()
  })
  return {
    prepareCodexHome,
    prepareClaudeAuth,
    // Why skip a client-sent home: its sessions live there, outside this host's trusted homes.
    prepareCodexSessionResume: async (resumeArgs) =>
      clientCodexHomes.readLaunchHome(resumeArgs.launchEnv)
        ? null
        : resumeLaunch.prepareCodexSessionResumeForLaunch(resumeArgs),
    runtimeDeps: {
      prepareCodexStructuredLaunch: async ({ launchEnv }) =>
        (await clientCodexHomes.selectLaunchHome(undefined, launchEnv)) ??
        prepareCodexHome(undefined, launchEnv),
      resolveCodexStructuredLaunchHome: ({ launchEnv }) =>
        clientCodexHomes.readLaunchHome(launchEnv) ??
        codexRuntimeHome.resolveHostCodexHomePathForLaunchReadOnly(launchEnv),
      prepareCodexCatalogProbeHome: (homePath) =>
        codexRuntimeHome.prepareHostCodexHomeForReadOnlyAppServer(
          homePath,
          resolveTuiAgentLaunchEnv('codex', store.getSettings())
        ),
      prepareAiVaultSessionResume: (resumeArgs) =>
        prepareCodexAiVaultSessionResume(resumeArgs, {
          runtimeHome: codexRuntimeHome,
          systemCodexHomePath: resolveHostCodexSessionSourceHome(store.getSettings()),
          preparePinnedLaunchHome: (home) => resumeLaunch.prepareCodexPinnedLaunchHome(home)
        })
    },
    listCodexSessionHomes: () => codexRuntimeHome.getHostCodexHomePathsForSessionDiscovery(),
    attachToRuntime: (runtime) => {
      runtime.setAccountServices({
        claudeAccounts: services.claudeAccounts,
        codexAccounts: services.codexAccounts,
        rateLimits: services.rateLimits
      })
      runtime.setCommitMessageAgentEnvironmentResolvers({
        prepareForCodexLaunch: prepareCodexHome,
        prepareForClaudeLaunch: prepareClaudeAuth,
        resolveBaseEnvironment: () => resolveHostAgentBaseEnvironment(store.getSettings())
      })
    }
  }
}
