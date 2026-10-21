import type { PtyRendererDelivery } from '../session'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { Store } from '../../../persistence'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalStartupCwdMissingDirFallback } from '../../../../shared/terminal-startup-cwd'
import type {
  CodexHomePtySpawnedLifecycleArgs,
  GetSelectedCodexHomePath,
  PrepareClaudeAuth,
  PrepareCodexSessionResume
} from '../host-env/types'
import type { StablePaneOwner } from '../pane/stable-owner'
import type { AdoptStablePaneArgs, AdoptStablePaneResult } from '../ipc/spawn-types'
import type { finishPtyShutdown } from '../provider/liveness'
import type { ResolvedPtyHost } from '../provider/registry'
import type { PtySpawnCodexResumeDeps } from '../spawn-host-env'

export type PtyRuntimeControllerDeps = PtySpawnCodexResumeDeps & {
  runtime?: OrcaRuntimeService
  store?: Store
  adoptStablePane: (args: AdoptStablePaneArgs) => Promise<AdoptStablePaneResult | null>
  getLocalPtyStartupPromise: (hostId?: ResolvedPtyHost) => Promise<void> | undefined
  getLocalPtyProviderStartupPromise: (hostId?: ResolvedPtyHost) => Promise<void> | undefined
  assertWorkspaceAcceptsNewPty: (
    worktreeId: string | undefined,
    sessionId?: string
  ) => Promise<void> | void
  resolvePtySpawnStartupCwd: (
    worktreeId: string | undefined,
    cwd: string | undefined,
    missingDirFallback?: TerminalStartupCwdMissingDirFallback
  ) => string | undefined
  requestSerializedBuffer: (
    ptyId: string,
    opts?: { scrollbackRows?: number }
  ) => Promise<{
    data: string
    cols: number
    rows: number
    seq?: number
    lastTitle?: string
    kittyKeyboardFlags?: number
  } | null>
  shutdownProviderAndDetectExit: (
    provider: IPtyProvider,
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ) => Promise<boolean>
  rememberSyntheticKillExit: (id: string, incarnationId?: string) => void
  rememberRetiredRejectedPty: (id: string) => void
  sendPtyExitToRenderer: (payload: { id: string; code: number; incarnationId?: string }) => void
  sendPtySpawnedToRenderer: (id: string) => void
  finishPtyShutdown: typeof finishPtyShutdown
  getSettings?: () => GlobalSettings | undefined
  getSelectedCodexHomePath?: GetSelectedCodexHomePath
  prepareClaudeAuth?: PrepareClaudeAuth
  options?: {
    onCodexHomePtySpawned?: (args: CodexHomePtySpawnedLifecycleArgs) => void
    prepareCodexSessionResume?: PrepareCodexSessionResume
  }
  trustedTerminalHandleEnv: Set<string>
  retiredRejectedPtyIds: Map<string, NodeJS.Timeout>
  mainWindow?: PtyRendererDelivery
  transitionSpawnHiddenRendererPtyDeliveryState?: (id: string, hidden: boolean) => void
  syncPtyBackgroundedDelivery?: (id: string, caller: string) => void
}

export type { StablePaneOwner }
