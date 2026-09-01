import type { KeybindingActionId, KeybindingFileSnapshot } from '../../shared/keybindings'
import type {
  WarpThemeImportPreview,
  WarpThemeImportSource
} from '../../shared/terminal-custom-themes'
import type { GhosttyImportPreview, GlobalSettings } from '../../shared/global-settings-types'
import type {
  AgentCatalogMutationRequest,
  AgentCatalogMutationResult,
  LocalAgentCatalogSnapshot,
  LocalCustomAgentDraftResult
} from '../../shared/agent-catalog-snapshot'
import type {
  AgentReferenceMutationRequest,
  AgentReferenceMutationResult,
  BaseDisableImpact,
  LocalAgentReferenceSnapshot,
  AgentReferenceSummary
} from '../../shared/agent-reference-snapshot'

export type SettingsApi = {
  get: () => Promise<GlobalSettings>
  /** Synchronous persisted-settings read for startup decisions that can't wait for async hydration. Blocking IPC — call sparingly. */
  getSync: () => GlobalSettings | null
  set: (args: Partial<GlobalSettings>) => Promise<GlobalSettings>
  setActiveRuntimeEnvironmentPreference: (args: {
    environmentId: string | null
  }) => Promise<GlobalSettings>
  updatePRBotAuthorOverride: (args: { author: string; isBot: boolean }) => Promise<GlobalSettings>
  listFonts: () => Promise<string[]>
  previewGhosttyImport: () => Promise<GhosttyImportPreview>
  previewWarpThemeImport: (source: WarpThemeImportSource) => Promise<WarpThemeImportPreview>
  /** Subscribe to out-of-band settings updates (e.g. View > Appearance toggles) to stay in sync with main. */
  onChanged: (callback: (updates: Partial<GlobalSettings>) => void) => () => void
  agentCatalog: {
    getLocal: () => Promise<LocalAgentCatalogSnapshot>
    mutate: (request: AgentCatalogMutationRequest) => Promise<AgentCatalogMutationResult>
    getLocalDraft: (args: {
      locator: { id?: unknown; repairToken?: unknown }
      expectedRevision?: number
    }) => Promise<LocalCustomAgentDraftResult | { status: 'stale' }>
    referenceSummary: (args: { id?: unknown }) => Promise<AgentReferenceSummary[]>
    baseDisableImpact: (args: { base?: unknown }) => Promise<BaseDisableImpact>
  }
  agentReferences: {
    getLocal: () => Promise<LocalAgentReferenceSnapshot>
    mutate: (
      request: AgentReferenceMutationRequest
    ) => Promise<AgentReferenceMutationResult<LocalAgentReferenceSnapshot>>
  }
}

export type KeybindingsApi = {
  get: () => Promise<KeybindingFileSnapshot>
  ensureFile: () => Promise<KeybindingFileSnapshot>
  setAction: (args: {
    actionId: KeybindingActionId
    bindings: string[] | null
  }) => Promise<KeybindingFileSnapshot>
  reload: () => Promise<KeybindingFileSnapshot>
  openFile: () => Promise<KeybindingFileSnapshot>
  revealFile: () => Promise<KeybindingFileSnapshot>
  onChanged: (callback: (snapshot: KeybindingFileSnapshot) => void) => () => void
}
