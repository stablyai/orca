/* eslint-disable max-lines -- Why: the web preload adapter is the browser-side
   replacement for Electron preload, so the compatibility surface is necessarily
   centralized at this boundary. */
import type {
  PreloadApi,
  PreflightStatus,
  RefreshAgentsResult,
  NativeChatApi,
  NativeChatReadSessionResult,
  NativeChatAppendedMessages
} from '../../../preload/api-types'
import type { CliInstallStatus } from '../../../shared/cli-install-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { AiVaultListArgs, AiVaultListResult } from '../../../shared/ai-vault-types'
import { buildNativeChatUnsubscribe } from '../../../shared/native-chat-stream-unsubscribe'
import type {
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../../shared/computer-use-permissions-types'
import type {
  DetectedWorktreeListResult,
  DirEntry,
  ForceDeleteWorktreeBranchResult,
  GlobalSettings,
  MemorySnapshot,
  OnboardingState,
  PersistedUIState,
  Repo,
  RemoveWorktreeResult,
  SearchResult,
  StatsSummary,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage,
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/types'
import type { SkillDiscoveryResult } from '../../../shared/skills'
import type { SshConnectionState, SshTarget } from '../../../shared/ssh-types'
import type {
  DevServerStatus,
  DevServer,
  DevServerListFilter,
  ConnectionTestResult,
  DevServerAccessRequest,
  DevServerGroup,
  DevServerGroupGrant
} from '../../../shared/dev-server-types'
import type {
  TenantUserProfile,
  TenantDepartment,
  TenantCompany
} from '../../../shared/tenant-user-profile-types'
import type { AdminUser } from '../../../shared/admin-user-types'
import {
  getDefaultOnboardingState,
  getDefaultSettings,
  getDefaultUIState,
  getDefaultWorkspaceSession,
  getWorktreeCardModeProperties,
  normalizeAgentActivityDisplayMode,
  normalizeWorktreeCardProperties,
  ONBOARDING_FLOW_VERSION
} from '../../../shared/constants'
import {
  createDefaultLocalOrcaProfile,
  DEFAULT_LOCAL_ORCA_PROFILE_ID
} from '../../../shared/orca-profiles'
import { legacyBaseRefSearchResult } from '../../../shared/base-ref-search-result'
import { EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS } from '../../../shared/pty-delivery-diagnostics'
import { createE2EConfig } from '../../../shared/e2e-config'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import {
  applyPRBotAuthorOverride,
  normalizePRBotAuthorOverrides
} from '../../../shared/pr-bot-author-overrides'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostScope,
  normalizeExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { toRuntimeWorktreeSelector } from '../runtime/runtime-worktree-selector'
import { debounce } from '../lib/debounce'
import { enqueueWrite, withRetryAndErrorStatus } from '../store/backend-go-storage'
import { normalizeDisabledTuiAgents } from '../../../shared/tui-agent-selection'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../shared/tui-agent-launch-defaults'
import { normalizeAutoRenameBranchFromWorkDefaultOn } from '../../../shared/auto-rename-branch-from-work-settings'
import { normalizeTerminalCursorStyleDefault } from '../../../shared/terminal-cursor-style-settings'
import { normalizeTerminalCustomThemes } from '../../../shared/terminal-custom-themes'
import { normalizeUiLanguage } from '../../../shared/ui-language'
import { normalizeUsagePercentageDisplay } from '../../../shared/usage-percentage-display'
import { buildAgentDetectionCommands } from '../../../shared/agent-detection-commands'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingPlatform,
  isKeybindingActionId,
  normalizeKeybindingArrayForAction,
  type KeybindingActionId,
  type KeybindingFileDiagnostic,
  type KeybindingFileSnapshot,
  type KeybindingOverrides,
  type KeybindingPlatform
} from '../../../shared/keybindings'
import {
  clearStoredWebRuntimeEnvironment,
  createStoredWebRuntimeEnvironment,
  getPreferredWebPairingOffer,
  readStoredWebRuntimeEnvironment,
  redactStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment,
  updateStoredEnvironmentRuntimeId,
  type StoredWebRuntimeEnvironment
} from './web-runtime-environment'
import { parseWebPairingInput } from './web-pairing'
import { WebRuntimeClient } from './web-runtime-client'
import { WebSessionClient } from './web-session-client'
import { RuntimeRpcCallQueuePool } from '../../../shared/runtime-rpc-call-queue'
import {
  assertClipboardTextWriteWithinLimitWithYield,
  assertClipboardTextWithinLimitWithYield,
  type ReadClipboardTextOptions
} from '../../../shared/clipboard-text'
import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR,
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../../shared/clipboard-image'
import { sanitizeWebRuntimeWorkspaceSession } from './web-workspace-session'
import {
  normalizeFeatureInteractions,
  type FeatureInteractionId,
  type FeatureInteractionState
} from '../../../shared/feature-interactions'
import { normalizeContextualTourIds, type ContextualTourId } from '../../../shared/contextual-tours'
import { translate } from '@/i18n/i18n'
import { getDefaultCreateProjectParent } from '@/components/sidebar/create-project-defaults'

const SETTINGS_STORAGE_KEY = 'orca.web.settings.v1'
const UI_STORAGE_KEY = 'orca.web.ui.v1'
const SESSION_STORAGE_KEY = 'orca.web.workspaceSession.v1'
const ONBOARDING_STORAGE_KEY = 'orca.web.onboarding.v1'
const GITHUB_CACHE_STORAGE_KEY = 'orca.web.githubCache.v1'
const KEYBINDINGS_STORAGE_KEY = 'orca.web.keybindings.v1'
// Why: browser-paired clients need desktop parity for large dev sessions; the
// runtime's no-limit default remains capped for lower-level RPC callers.
const WEB_RUNTIME_WORKTREE_LIST_LIMIT = 10_000
const MAX_CLIPBOARD_IMAGE_BASE64_CHARS = CLIPBOARD_IMAGE_MAX_BASE64_CHARS
export const MAX_CLIPBOARD_IMAGE_SOURCE_BYTES = CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
export const MAX_CLIPBOARD_IMAGE_PIXELS = CLIPBOARD_IMAGE_MAX_PIXELS
export const CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
export const CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS = 256 * 1024
const CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS = 30_000

let activeEnvironment: StoredWebRuntimeEnvironment | null = readStoredWebRuntimeEnvironment()
let activeClient: WebRuntimeClient | WebSessionClient | null = null
let activeClientEnvironmentId: string | null = null
let cachedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null = null
let cachedDetectedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null = null
const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const commaIndex = result.indexOf(',')
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read clipboard image'))
    reader.readAsDataURL(blob)
  })
}

function assertClipboardImageBlobWithinLimit(blob: Blob): void {
  assertClipboardImageByteLengthWithinLimit(blob.size)
}

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  assertClipboardImageBlobWithinLimit(blob)
  const bitmap = await createImageBitmap(blob)
  try {
    assertClipboardImageDimensionsWithinLimit(bitmap)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context || canvas.width <= 0 || canvas.height <= 0) {
      throw new Error('Clipboard image could not be decoded')
    }
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => {
        if (!png) {
          reject(new Error('Clipboard image could not be encoded as PNG'))
          return
        }
        try {
          assertClipboardImageBlobWithinLimit(png)
        } catch (error) {
          reject(error)
          return
        }
        resolve(png)
      }, 'image/png')
    })
  } finally {
    bitmap.close()
  }
}

async function readClipboardImagePngBase64(): Promise<string | null> {
  const clipboard = navigator.clipboard as
    | (Clipboard & { read?: () => Promise<ClipboardItem[]> })
    | undefined
  if (!clipboard?.read) {
    return null
  }
  const items = await clipboard.read()
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith('image/'))
    if (!imageType) {
      continue
    }
    const blob = await item.getType(imageType)
    assertClipboardImageBlobWithinLimit(blob)
    const pngBlob = imageType === 'image/png' ? blob : await convertImageBlobToPng(blob)
    return blobToBase64(pngBlob)
  }
  return null
}

function invalidateRuntimeWorktreeCaches(): void {
  cachedWorktrees = null
  cachedDetectedWorktrees = null
}

type WebSettingsApi = NonNullable<PreloadApi['settings']>
type WebKeybindingsApi = NonNullable<PreloadApi['keybindings']>
type WebGitHubApi = NonNullable<PreloadApi['gh']>
type WebGitHubResult<K extends keyof WebGitHubApi> = Awaited<ReturnType<WebGitHubApi[K]>>
type WebGitHubRouteKey =
  | 'repoSlug'
  | 'repoUpstream'
  | 'prForBranch'
  | 'issue'
  | 'workItem'
  | 'workItemByOwnerRepo'
  | 'workItemDetails'
  | 'prFileContents'
  | 'listIssues'
  | 'createIssue'
  | 'countWorkItems'
  | 'listWorkItems'
  | 'prChecks'
  | 'prCheckDetails'
  | 'rerunPRChecks'
  | 'prComments'
  | 'resolveReviewThread'
  | 'setPRFileViewed'
  | 'updatePRTitle'
  | 'mergePR'
  | 'setPRAutoMerge'
  | 'updatePRState'
  | 'requestPRReviewers'
  | 'removePRReviewers'
  | 'updateIssue'
  | 'addIssueComment'
  | 'addPRReviewCommentReply'
  | 'addPRReviewComment'
  | 'listLabels'
  | 'listAssignableUsers'
  | 'rateLimit'
  | 'listAccessibleProjects'
  | 'resolveProjectRef'
  | 'listProjectViews'
  | 'getProjectViewTable'
  | 'projectWorkItemDetailsBySlug'
  | 'updateProjectItemField'
  | 'clearProjectItemField'
  | 'updateIssueBySlug'
  | 'updatePullRequestBySlug'
  | 'addIssueCommentBySlug'
  | 'updateIssueCommentBySlug'
  | 'deleteIssueCommentBySlug'
  | 'listLabelsBySlug'
  | 'listAssignableUsersBySlug'
  | 'listIssueTypesBySlug'
  | 'updateIssueTypeBySlug'
type WebGitHubRuntimeMethod =
  | 'github.repoSlug'
  | 'github.repoUpstream'
  | 'github.prForBranch'
  | 'github.issue'
  | 'github.workItem'
  | 'github.workItemByOwnerRepo'
  | 'github.workItemDetails'
  | 'github.prFileContents'
  | 'github.listIssues'
  | 'github.createIssue'
  | 'github.countWorkItems'
  | 'github.listWorkItems'
  | 'github.prChecks'
  | 'github.prCheckDetails'
  | 'github.rerunPRChecks'
  | 'github.prComments'
  | 'github.resolveReviewThread'
  | 'github.setPRFileViewed'
  | 'github.updatePRTitle'
  | 'github.mergePR'
  | 'github.setPRAutoMerge'
  | 'github.updatePRState'
  | 'github.requestPRReviewers'
  | 'github.removePRReviewers'
  | 'github.updateIssue'
  | 'github.addIssueComment'
  | 'github.addPRReviewCommentReply'
  | 'github.addPRReviewComment'
  | 'github.listLabels'
  | 'github.listAssignableUsers'
  | 'github.rateLimit'
  | 'github.project.listAccessible'
  | 'github.project.resolveRef'
  | 'github.project.listViews'
  | 'github.project.viewTable'
  | 'github.project.workItemDetailsBySlug'
  | 'github.project.updateItemField'
  | 'github.project.clearItemField'
  | 'github.project.updateIssueBySlug'
  | 'github.project.updatePullRequestBySlug'
  | 'github.project.addIssueCommentBySlug'
  | 'github.project.updateIssueCommentBySlug'
  | 'github.project.deleteIssueCommentBySlug'
  | 'github.project.listLabelsBySlug'
  | 'github.project.listAssignableUsersBySlug'
  | 'github.project.listIssueTypesBySlug'
  | 'github.project.updateIssueTypeBySlug'
type WebGitLabApi = NonNullable<PreloadApi['gl']>
type WebGitLabResult<K extends keyof WebGitLabApi> = Awaited<ReturnType<WebGitLabApi[K]>>
type WebGitLabRouteKey =
  | 'diagnoseAuth'
  | 'rateLimit'
  | 'listMRs'
  | 'listWorkItems'
  | 'listIssues'
  | 'createIssue'
  | 'updateIssue'
  | 'addIssueComment'
  | 'listLabels'
  | 'todos'
  | 'workItemDetails'
  | 'closeMR'
  | 'reopenMR'
  | 'mergeMR'
  | 'updateMR'
  | 'updateMRReviewers'
  | 'addMRComment'
  | 'addMRInlineComment'
  | 'resolveMRDiscussion'
  | 'jobTrace'
  | 'retryJob'
  | 'workItemByPath'
type WebGitLabRuntimeMethod =
  | 'gitlab.diagnoseAuth'
  | 'gitlab.rateLimit'
  | 'gitlab.listMRs'
  | 'gitlab.listWorkItems'
  | 'gitlab.listIssues'
  | 'gitlab.createIssue'
  | 'gitlab.updateIssue'
  | 'gitlab.addIssueComment'
  | 'gitlab.listLabels'
  | 'gitlab.todos'
  | 'gitlab.workItemDetails'
  | 'gitlab.updateMRState'
  | 'gitlab.mergeMR'
  | 'gitlab.updateMR'
  | 'gitlab.updateMRReviewers'
  | 'gitlab.addMRComment'
  | 'gitlab.addMRInlineComment'
  | 'gitlab.resolveMRDiscussion'
  | 'gitlab.jobTrace'
  | 'gitlab.retryJob'
  | 'gitlab.workItemByPath'
type WebKeybindingDocument = {
  version: 1
  keybindings: KeybindingOverrides
  platforms: Partial<Record<KeybindingPlatform, KeybindingOverrides>>
}

export const GITHUB_WEB_RPC_METHODS = {
  repoSlug: 'github.repoSlug',
  repoUpstream: 'github.repoUpstream',
  prForBranch: 'github.prForBranch',
  issue: 'github.issue',
  workItem: 'github.workItem',
  workItemByOwnerRepo: 'github.workItemByOwnerRepo',
  workItemDetails: 'github.workItemDetails',
  prFileContents: 'github.prFileContents',
  listIssues: 'github.listIssues',
  createIssue: 'github.createIssue',
  countWorkItems: 'github.countWorkItems',
  listWorkItems: 'github.listWorkItems',
  prChecks: 'github.prChecks',
  prCheckDetails: 'github.prCheckDetails',
  rerunPRChecks: 'github.rerunPRChecks',
  prComments: 'github.prComments',
  resolveReviewThread: 'github.resolveReviewThread',
  setPRFileViewed: 'github.setPRFileViewed',
  updatePRTitle: 'github.updatePRTitle',
  mergePR: 'github.mergePR',
  setPRAutoMerge: 'github.setPRAutoMerge',
  updatePRState: 'github.updatePRState',
  requestPRReviewers: 'github.requestPRReviewers',
  removePRReviewers: 'github.removePRReviewers',
  updateIssue: 'github.updateIssue',
  addIssueComment: 'github.addIssueComment',
  addPRReviewCommentReply: 'github.addPRReviewCommentReply',
  addPRReviewComment: 'github.addPRReviewComment',
  listLabels: 'github.listLabels',
  listAssignableUsers: 'github.listAssignableUsers',
  rateLimit: 'github.rateLimit',
  listAccessibleProjects: 'github.project.listAccessible',
  resolveProjectRef: 'github.project.resolveRef',
  listProjectViews: 'github.project.listViews',
  getProjectViewTable: 'github.project.viewTable',
  projectWorkItemDetailsBySlug: 'github.project.workItemDetailsBySlug',
  updateProjectItemField: 'github.project.updateItemField',
  clearProjectItemField: 'github.project.clearItemField',
  updateIssueBySlug: 'github.project.updateIssueBySlug',
  updatePullRequestBySlug: 'github.project.updatePullRequestBySlug',
  addIssueCommentBySlug: 'github.project.addIssueCommentBySlug',
  updateIssueCommentBySlug: 'github.project.updateIssueCommentBySlug',
  deleteIssueCommentBySlug: 'github.project.deleteIssueCommentBySlug',
  listLabelsBySlug: 'github.project.listLabelsBySlug',
  listAssignableUsersBySlug: 'github.project.listAssignableUsersBySlug',
  listIssueTypesBySlug: 'github.project.listIssueTypesBySlug',
  updateIssueTypeBySlug: 'github.project.updateIssueTypeBySlug'
} as const satisfies Record<WebGitHubRouteKey, WebGitHubRuntimeMethod>

export const GITLAB_WEB_RPC_METHODS = {
  diagnoseAuth: 'gitlab.diagnoseAuth',
  rateLimit: 'gitlab.rateLimit',
  listMRs: 'gitlab.listMRs',
  listWorkItems: 'gitlab.listWorkItems',
  listIssues: 'gitlab.listIssues',
  createIssue: 'gitlab.createIssue',
  updateIssue: 'gitlab.updateIssue',
  addIssueComment: 'gitlab.addIssueComment',
  listLabels: 'gitlab.listLabels',
  todos: 'gitlab.todos',
  workItemDetails: 'gitlab.workItemDetails',
  closeMR: 'gitlab.updateMRState',
  reopenMR: 'gitlab.updateMRState',
  mergeMR: 'gitlab.mergeMR',
  updateMR: 'gitlab.updateMR',
  updateMRReviewers: 'gitlab.updateMRReviewers',
  addMRComment: 'gitlab.addMRComment',
  addMRInlineComment: 'gitlab.addMRInlineComment',
  resolveMRDiscussion: 'gitlab.resolveMRDiscussion',
  jobTrace: 'gitlab.jobTrace',
  retryJob: 'gitlab.retryJob',
  workItemByPath: 'gitlab.workItemByPath'
} as const satisfies Record<WebGitLabRouteKey, WebGitLabRuntimeMethod>

const WEB_KEYBINDING_PLATFORMS: readonly KeybindingPlatform[] = ['darwin', 'linux', 'win32']
const webKeybindingListeners = new Set<(snapshot: KeybindingFileSnapshot) => void>()

export function installWebPreloadApi(): void {
  activeEnvironment = readStoredWebRuntimeEnvironment()
  const webWindow = window as unknown as { __ORCA_WEB_CLIENT__?: boolean }
  webWindow.__ORCA_WEB_CLIENT__ = true
  window.electron = createFallbackProxy(['electron']) as Window['electron']
  window.api = withFallback(createWebPreloadApi(), []) as PreloadApi
}

function createWebPreloadApi(): Partial<PreloadApi> {
  const webOrcaProfileAuthStatus = () =>
    Promise.resolve({
      activeProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
      configured: false,
      state: 'unconfigured' as const,
      persistence: 'none' as const,
      setupMessage: 'Orca Cloud sign-in is not available in the browser fallback.'
    })

  return {
    app: {
      getIdentity: () =>
        Promise.resolve({
          name: 'Orca',
          isDev: false,
          devLabel: null,
          devBranch: null,
          devWorktreeName: null,
          devRepoRoot: null,
          dockBadgeLabel: null
        }),
      getFeatureWallAssetBaseUrl: () => Promise.resolve('/'),
      relaunch: () => Promise.resolve(window.location.reload()),
      restart: () => Promise.resolve(window.location.reload()),
      reload: () => Promise.resolve(window.location.reload()),
      awaitFirstWindowStartupServices: () => Promise.resolve(),
      startupDiagnostic: () => Promise.resolve(),
      getKeyboardInputSourceId: () => Promise.resolve(null),
      setUnreadDockBadgeCount: () => Promise.resolve(),
      getFloatingTerminalCwd: () => Promise.resolve(''),
      getFloatingMarkdownDirectory: () => Promise.resolve(''),
      pickFloatingMarkdownDocument: () => Promise.resolve(null),
      pickFloatingWorkspaceDirectory: () => Promise.resolve(null)
    },
    starNag: {
      onShow: () => noopUnsubscribe,
      onHide: () => noopUnsubscribe,
      dismiss: () => Promise.resolve(),
      later: () => Promise.resolve(),
      complete: () => Promise.resolve(),
      disable: () => Promise.resolve(),
      openWeb: () => Promise.resolve(),
      starOrca: () => Promise.resolve(false),
      forceShow: () => Promise.resolve(),
      agentValueMoment: () => Promise.resolve({ status: 'skipped' }),
      showAgentValueMoment: () => Promise.resolve(),
      onboardingCompleted: () => Promise.resolve()
    },
    platform: {
      get: () => ({
        platform: getBrowserPlatform(),
        osRelease: '',
        displayServer: null
      })
    },
    orcaProfiles: {
      list: () =>
        Promise.resolve({
          activeProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
          profiles: [createDefaultLocalOrcaProfile(0)],
          multiProfileUi: false
        }),
      authStatus: webOrcaProfileAuthStatus,
      createLocal: () =>
        Promise.resolve({
          activeProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
          profiles: [createDefaultLocalOrcaProfile(0)],
          profile: createDefaultLocalOrcaProfile(0)
        }),
      createCloudLinked: async () => ({
        status: 'unconfigured',
        auth: await webOrcaProfileAuthStatus()
      }),
      switchProfile: () => Promise.resolve({ status: 'already-active' }),
      transferProject: (args) =>
        Promise.resolve({
          status: 'duplicate-target',
          sourceProfileId: args.sourceProfileId,
          targetProfileId: args.targetProfileId,
          sourceRepoId: args.repoId,
          duplicateRepoId: args.repoId
        }),
      findProjectProfiles: async () => ({ projects: [] }),
      connectCurrent: async () => ({
        status: 'unconfigured',
        auth: await webOrcaProfileAuthStatus()
      }),
      refreshAuth: async () => ({
        status: 'unconfigured',
        auth: await webOrcaProfileAuthStatus()
      }),
      signOutCurrent: async () => ({
        status: 'signed-out',
        auth: await webOrcaProfileAuthStatus(),
        activeProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
        profiles: [createDefaultLocalOrcaProfile(0)]
      }),
      selectOrg: async () => ({
        status: 'unconfigured',
        auth: await webOrcaProfileAuthStatus()
      }),
      orgMembersList: async () => ({ status: 'unconfigured' }),
      orgMemberInvite: async () => ({ status: 'unconfigured' }),
      orgInviteRevoke: async () => ({ status: 'unconfigured' }),
      orgMemberChangeRole: async () => ({ status: 'unconfigured' }),
      orgMemberRemove: async () => ({ status: 'unconfigured' })
    },
    e2e: {
      getConfig: () => createE2EConfig({})
    },
    settings: {
      // FE-TASK-STORAGE-006: prefer the full GlobalSettings mirror once
      // backend-go has one; only the legacy 5-field path (which never has
      // more than those 5 keys) falls back to getRuntimeBackedStoredSettings.
      get: async () => {
        const full = await getFullClientSettings()
        if (full !== null) {
          writeJson(SETTINGS_STORAGE_KEY, full) // keep localStorage cache in sync
          return full
        }
        const legacy = await getRuntimeBackedStoredSettings()
        // FE-TASK-STORAGE-007: seed the full-settings backend-go record once,
        // from whatever's authoritative today, so an existing user's
        // preferences aren't silently reset to defaults the first time this
        // rolls out. Fire-and-forget — settings.get must not block on this
        // write; ensureFullSettingsSeeded re-checks for a remote record
        // itself, so a second concurrent settings.get() call won't double-seed.
        void ensureFullSettingsSeeded()
        return legacy
      },
      // Why: localStorage-backed settings are synchronous in the web client,
      // so the pre-hydration kill-switch read works the same as desktop.
      // FE-TASK-STORAGE-006: intentionally UNCHANGED — no RPC is synchronous,
      // so this still reads the localStorage cache directly.
      getSync: () => getStoredSettings(),
      set: async (updates) => {
        if (updates.activeRuntimeEnvironmentId === null) {
          disconnectActiveRuntimeEnvironment()
        }
        const sanitizedUpdates = { ...updates }
        if ('autoRenameBranchFromWorkDefaultedOn' in sanitizedUpdates) {
          sanitizedUpdates.autoRenameBranchFromWorkDefaultedOn = true
        }
        const next = mergeSettings(getStoredSettings(), sanitizedUpdates, {
          preserveAutoRenameBranchFromWorkUpdate: 'autoRenameBranchFromWork' in sanitizedUpdates
        })
        writeJson(SETTINGS_STORAGE_KEY, next)
        // FE-TASK-STORAGE-005 (finishing what FE-TASK-STORAGE-006 deferred):
        // persistence-status.ts (FE-TASK-STORAGE-004) has landed now, so the
        // full-settings backend-go sync goes through the same
        // enqueueWrite/withRetryAndErrorStatus machinery keybindings.ts uses
        // — 3 retries (2s/4s/8s) then a visible 'error' status via
        // PersistenceStatusBanner, instead of a single console.error.
        // Fire-and-forget (void, not awaited): the retry sequence can take
        // up to ~14s on repeated failure, and settings.set's caller
        // (store/slices/settings.ts's updateSettings) must not block the UI
        // for that — same reasoning as persistKeybindingsToBackendGo's
        // `void enqueueWrite(...)`.
        void enqueueWrite('settings', () =>
          withRetryAndErrorStatus('settings', () => syncFullClientSettings(next))
        )
        // The legacy 5-field sync is independent (no shared transaction with
        // the write above) and never rejects (it catches internally and
        // resolves with `next`) — awaited directly since its result feeds
        // this handler's own return value below.
        return await syncRuntimeBackedSettings(sanitizedUpdates, next)
      },
      updatePRBotAuthorOverride: (args) => updateRuntimePRBotAuthorOverride(args),
      listFonts: () => Promise.resolve([]),
      onChanged: () => noopUnsubscribe
    } satisfies Partial<WebSettingsApi> as unknown as WebSettingsApi,
    keybindings: createWebKeybindingsApi(),
    ui: createWebUiApi(),
    crashReports: {
      getLatestPending: () => Promise.resolve(null),
      getLatestReport: () => Promise.resolve(null),
      dismiss: () => Promise.resolve(null),
      recordRendererError: () => Promise.resolve({ ok: true, report: null, deduped: true }),
      recordBreadcrumb: () => {},
      submit: () =>
        Promise.resolve({
          ok: false,
          status: null,
          error: translate('auto.web.web.preload.api.fb290366b2', 'Unavailable on web.')
        }),
      copyLatestDiagnostics: () =>
        Promise.resolve({
          ok: false,
          error: translate('auto.web.web.preload.api.fb290366b2', 'Unavailable on web.')
        })
    },
    diagnostics: {
      getStatus: () =>
        Promise.resolve({
          localFileEnabled: false,
          bundleEnabled: false,
          traceFilePath: '',
          traceFamilySize: 0
        }),
      collectBundle: () => Promise.reject(new Error('Review files are unavailable on web.')),
      openBundlePreview: () => Promise.reject(new Error('Review files are unavailable on web.')),
      discardBundlePreview: () => Promise.resolve(),
      uploadBundle: () => Promise.reject(new Error('Sending diagnostics is unavailable on web.')),
      deleteBundle: () => Promise.reject(new Error('Sent diagnostics are unavailable on web.'))
    },
    session: {
      // hostId mirrors the desktop bridge: omitted/'local' targets the existing
      // storage key; non-local hosts persist under a host-suffixed key so their
      // sessions stay isolated from the local one.
      get: (hostId) => Promise.resolve(getStoredWorkspaceSession(hostId)),
      set: async (session, hostId) => {
        writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session))
        // FE-TASK-STORAGE-008: fire-and-forget, debounced — see
        // flushWorkspaceSessionRemote's own comment for why this never blocks.
        void flushWorkspaceSessionRemote(hostId ?? undefined)
      },
      patch: async (patch: WorkspaceSessionPatch, hostId) => {
        writeJson(
          sessionStorageKeyForHost(hostId),
          sanitizeWebRuntimeWorkspaceSession({
            ...getStoredWorkspaceSession(hostId),
            ...patch
          })
        )
        void flushWorkspaceSessionRemote(hostId ?? undefined)
      },
      readTerminalScrollback: () => null,
      // Why setSync never calls flushWorkspaceSessionRemote: this is used from
      // beforeunload, which gives no time to wait on a network RPC (and the
      // debounce below wouldn't fire before the tab closes anyway). The most
      // recent change may lag backend-go by up to `wait`/`maxWait` if the tab
      // closes before a pending debounce fires — accepted, documented gap
      // (FE-SOL-STORAGE-004 "Rủi ro"), not a bug: localStorage already has the
      // correct value for this device.
      setSync: (session, hostId) => {
        writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session))
      }
    },
    onboarding: {
      get: () => Promise.resolve(getStoredOnboarding()),
      update: async (updates) => {
        const current = getStoredOnboarding()
        const next: OnboardingState = {
          ...current,
          ...updates,
          flowVersion: ONBOARDING_FLOW_VERSION,
          checklist: {
            ...current.checklist,
            ...updates.checklist
          }
        }
        writeJson(ONBOARDING_STORAGE_KEY, next)
        return next
      },
      // Why: the web build has no paired Electron desktop process, so
      // preflight.detectAgents (createPreflightApi below) can never answer
      // "which agent CLIs are installed" — it's gated on a runtime
      // environment pairing that a plain browser session never has. This is
      // the real answer for a dev-server-agent connection: relay the
      // agent's own confirmed preflight.detectAgents RPC through the
      // backend's onboarding.detectAgents channel, which resolves
      // devServerId to a live connection and asks THAT host. commands is
      // built here (not passed in by callers) from the same TUI_AGENT_CONFIG
      // catalog desktop's relay bridge uses — see buildAgentDetectionCommands.
      detectAgents: (params) =>
        callRuntimeResult<{
          agents: string[]
          platform: NodeJS.Platform | null
          devServerId: string | null
        }>('onboarding.detectAgents', {
          devServerId: params.devServerId,
          commands: buildAgentDetectionCommands()
        }).catch(() => ({ agents: [], platform: null, devServerId: params.devServerId }))
    },
    cache: {
      getGitHub: () =>
        Promise.resolve(
          readJson(GITHUB_CACHE_STORAGE_KEY, {
            pr: {},
            issue: {}
          })
        ),
      setGitHub: async ({ cache }) => {
        writeJson(GITHUB_CACHE_STORAGE_KEY, cache)
      }
    },
    runtime: createRuntimeApi(),
    nativeChat: createNativeChatApi(),
    runtimeEnvironments: createRuntimeEnvironmentsApi(),
    repos: createReposApi(),
    worktrees: createWorktreesApi(),
    fs: createFileApi(),
    git: createGitApi(),
    browser: createBrowserApi(),
    emulator: createEmulatorApi(),
    gh: createGitHubApi(),
    gl: createGitLabApi(),
    hostedReview: createRuntimeNamespaceApi('hostedReview'),
    linear: createRuntimeNamespaceApi('linear'),
    devServer: createDevServerApi(),
    devServerGroup: createDevServerGroupApi(),
    tenantProfile: createTenantProfileApi(),
    admin: createAdminApi(),
    hooks: createHooksApi(),
    stats: {
      getSummary: async () =>
        callRuntimeResult<StatsSummary>('stats.summary').catch(() => ({
          totalAgentsSpawned: 0,
          totalPRsCreated: 0,
          totalAgentTimeMs: 0,
          firstEventAt: null
        }))
    },
    memory: {
      getSnapshot: () => Promise.resolve(createEmptyMemorySnapshot())
    },
    aiVault: createAiVaultApi(),
    preflight: createPreflightApi(),
    notifications: createNotificationsApi(),
    rateLimits: createRateLimitsApi(),
    minimaxCredentials: createMiniMaxCredentialsApi(),
    grokAccounts: createGrokAccountsApi(),
    codexAccounts: createAccountsApi(),
    claudeAccounts: createAccountsApi(),
    cli: createCliApi(),
    agentHooks: createAgentHooksApi(),
    developerPermissions: createDeveloperPermissionsApi(),
    computerUsePermissions: createComputerUsePermissionsApi(),
    updater: createUpdaterApi(),
    shell: createShellApi(),
    skills: createSkillsApi(),
    pty: createPtyApi(),
    ssh: createSshApi(),
    wsl: {
      isAvailable: () => callRuntimeResult<boolean>('host.wsl.isAvailable').catch(() => false),
      listDistros: () => callRuntimeResult<string[]>('host.wsl.listDistros').catch(() => [])
    },
    pwsh: {
      isAvailable: () => callRuntimeResult<boolean>('host.pwsh.isAvailable').catch(() => false)
    },
    gitBash: {
      isAvailable: () => callRuntimeResult<boolean>('host.gitBash.isAvailable').catch(() => false)
    },
    agentStatus: {
      onSet: () => noopUnsubscribe,
      onClear: () => noopUnsubscribe,
      getSnapshot: () => Promise.resolve([]),
      inferInterrupt: () => Promise.resolve(false),
      onMigrationUnsupported: () => noopUnsubscribe,
      onMigrationUnsupportedClear: () => noopUnsubscribe,
      getMigrationUnsupportedSnapshot: () => Promise.resolve([]),
      drop: () => {},
      dropByTabPrefix: () => {}
    },
    mobile: {
      listNetworkInterfaces: () => Promise.resolve({ interfaces: [] }),
      getPairingQR: () => Promise.resolve({ available: false }),
      getWindowsFirewallStatus: () => Promise.resolve({ supported: false }),
      repairWindowsFirewall: () => Promise.resolve({ ok: false, reason: 'unsupported' }),
      openWindowsNetworkSettings: () => Promise.resolve(false),
      getRuntimePairingUrl: () => Promise.resolve({ available: false }),
      listDevices: () => Promise.resolve({ devices: [] }),
      revokeDevice: () => Promise.resolve({ revoked: false }),
      listRuntimeAccessGrants: () => Promise.resolve({ grants: [] }),
      revokeRuntimeAccess: () => Promise.resolve({ revoked: false }),
      isWebSocketReady: () => Promise.resolve({ ready: Boolean(activeEnvironment), endpoint: null })
    },
    telemetryTrack: () => Promise.resolve(),
    telemetrySetOptIn: () => Promise.resolve(),
    telemetryGetConsentState: () =>
      Promise.resolve({ optedIn: false, source: 'default', blockedByEnv: false } as never),
    telemetryAcknowledgeBanner: () => Promise.resolve()
  }
}

function createEmptyWebKeybindingDocument(): WebKeybindingDocument {
  return {
    version: 1,
    keybindings: {},
    platforms: {
      darwin: {},
      linux: {},
      win32: {}
    }
  }
}

function getWebKeybindingPlatform(): KeybindingPlatform {
  return getKeybindingPlatform(getBrowserPlatform())
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStoredWebOverrides(
  value: unknown,
  section: string,
  diagnostics: KeybindingFileDiagnostic[]
): KeybindingOverrides {
  if (value === undefined) {
    return {}
  }
  if (!isJsonObject(value)) {
    diagnostics.push({
      severity: 'error',
      section,
      message: translate('auto.web.web.preload.api.d2e43e426a', '{{value0}} must be an object.', {
        value0: section
      })
    })
    return {}
  }

  const overrides: KeybindingOverrides = {}
  for (const [actionId, rawBindings] of Object.entries(value)) {
    if (!isKeybindingActionId(actionId)) {
      diagnostics.push({
        severity: 'warning',
        section,
        actionId,
        message: translate(
          'auto.web.web.preload.api.36761d9604',
          'Unknown keybinding action "{{value0}}" was ignored.',
          { value0: actionId }
        )
      })
      continue
    }
    if (
      !Array.isArray(rawBindings) ||
      !rawBindings.every((binding) => typeof binding === 'string')
    ) {
      diagnostics.push({
        severity: 'error',
        section,
        actionId,
        message: translate(
          'auto.web.web.preload.api.10898045f3',
          'Shortcut for "{{value0}}" was ignored: Use a string array.',
          { value0: actionId }
        )
      })
      continue
    }
    const normalized = normalizeKeybindingArrayForAction(actionId, rawBindings)
    if (!Array.isArray(normalized)) {
      const error = normalized.ok ? 'Unable to parse shortcut.' : normalized.error
      diagnostics.push({
        severity: 'error',
        section,
        actionId,
        message: translate(
          'auto.web.web.preload.api.76122208ca',
          'Shortcut for "{{value0}}" was ignored: {{value1}}',
          { value0: actionId, value1: error }
        )
      })
      continue
    }
    overrides[actionId] = normalized
  }
  return overrides
}

function normalizeWebPlatformOverrides(
  value: unknown,
  diagnostics: KeybindingFileDiagnostic[]
): Partial<Record<KeybindingPlatform, KeybindingOverrides>> {
  if (value === undefined) {
    return {}
  }
  if (!isJsonObject(value)) {
    diagnostics.push({
      severity: 'error',
      section: 'platforms',
      message: translate(
        'auto.web.web.preload.api.0a69fcd8bc',
        'platforms must be an object with darwin, linux, or win32 sections.'
      )
    })
    return {}
  }

  const result: Partial<Record<KeybindingPlatform, KeybindingOverrides>> = {}
  for (const [platform, overrides] of Object.entries(value)) {
    if (!WEB_KEYBINDING_PLATFORMS.includes(platform as KeybindingPlatform)) {
      diagnostics.push({
        severity: 'warning',
        section: `platforms.${platform}`,
        message: translate(
          'auto.web.web.preload.api.32f15bdb0f',
          'Unknown platform "{{value0}}" was ignored.',
          { value0: platform }
        )
      })
      continue
    }
    result[platform as KeybindingPlatform] = normalizeStoredWebOverrides(
      overrides,
      `platforms.${platform}`,
      diagnostics
    )
  }
  return result
}

function removeConflictingWebOverrides(
  platform: KeybindingPlatform,
  overrides: KeybindingOverrides,
  diagnostics: KeybindingFileDiagnostic[]
): KeybindingOverrides {
  let next = { ...overrides }
  for (let attempt = 0; attempt < 20; attempt++) {
    const conflicts = findKeybindingConflicts(platform, next)
    const conflictingOverrides = new Set<KeybindingActionId>()
    for (const conflict of conflicts) {
      for (const actionId of conflict.actionIds) {
        if (Object.prototype.hasOwnProperty.call(next, actionId)) {
          conflictingOverrides.add(actionId)
        }
      }
    }
    if (conflictingOverrides.size === 0) {
      return next
    }
    for (const actionId of conflictingOverrides) {
      delete next[actionId]
    }
    diagnostics.push({
      severity: 'error',
      message: translate(
        'auto.web.web.preload.api.52bee9d8a0',
        'Conflicting custom shortcuts were ignored: {{value0}}.',
        {
          value0: Array.from(conflictingOverrides)
            .map((actionId) => actionId)
            .join(', ')
        }
      )
    })
  }
  return next
}

function readWebKeybindingDocument(): WebKeybindingDocument {
  const document = readJson(KEYBINDINGS_STORAGE_KEY, createEmptyWebKeybindingDocument())
  return {
    version: 1,
    keybindings: isJsonObject(document.keybindings)
      ? (document.keybindings as KeybindingOverrides)
      : {},
    platforms: isJsonObject(document.platforms)
      ? (document.platforms as Partial<Record<KeybindingPlatform, KeybindingOverrides>>)
      : {}
  }
}

function getWebKeybindingSnapshot(): KeybindingFileSnapshot {
  const platform = getWebKeybindingPlatform()
  const diagnostics: KeybindingFileDiagnostic[] = []
  const document = readWebKeybindingDocument()
  const commonOverrides = normalizeStoredWebOverrides(
    document.keybindings,
    'keybindings',
    diagnostics
  )
  const platformOverrides = normalizeWebPlatformOverrides(document.platforms, diagnostics)
  const overrides = removeConflictingWebOverrides(
    platform,
    {
      ...commonOverrides,
      ...platformOverrides[platform]
    },
    diagnostics
  )

  return {
    path: 'Browser local storage',
    platform,
    exists: window.localStorage.getItem(KEYBINDINGS_STORAGE_KEY) !== null,
    overrides,
    commonOverrides,
    platformOverrides,
    diagnostics
  }
}

function writeWebKeybindingAction(
  actionId: KeybindingActionId,
  bindings: string[] | null
): KeybindingFileSnapshot {
  if (!isKeybindingActionId(actionId)) {
    throw new Error(`Unknown keybinding action "${actionId}".`)
  }
  const normalizedBindings =
    bindings === null ? null : normalizeKeybindingArrayForAction(actionId, bindings)
  if (normalizedBindings !== null && !Array.isArray(normalizedBindings)) {
    throw new Error(normalizedBindings.ok ? 'Unable to parse shortcut.' : normalizedBindings.error)
  }

  const platform = getWebKeybindingPlatform()
  const currentSnapshot = getWebKeybindingSnapshot()
  const candidateOverrides = { ...currentSnapshot.overrides }
  if (normalizedBindings === null) {
    delete candidateOverrides[actionId]
  } else {
    candidateOverrides[actionId] = normalizedBindings
  }
  const blockingConflict = findKeybindingConflicts(platform, candidateOverrides).find((conflict) =>
    conflict.actionIds.includes(actionId)
  )
  if (blockingConflict) {
    throw new Error(
      `${formatKeybindingList([blockingConflict.binding], platform)} conflicts with another shortcut.`
    )
  }

  const activePlatform: KeybindingOverrides = { ...currentSnapshot.platformOverrides[platform] }
  if (normalizedBindings === null) {
    delete activePlatform[actionId]
  } else {
    activePlatform[actionId] = normalizedBindings
  }

  writeJson(KEYBINDINGS_STORAGE_KEY, {
    version: 1,
    keybindings: currentSnapshot.commonOverrides,
    platforms: {
      ...currentSnapshot.platformOverrides,
      darwin: currentSnapshot.platformOverrides.darwin ?? {},
      linux: currentSnapshot.platformOverrides.linux ?? {},
      win32: currentSnapshot.platformOverrides.win32 ?? {},
      [platform]: activePlatform
    }
  } satisfies WebKeybindingDocument)

  const snapshot = getWebKeybindingSnapshot()
  notifyWebKeybindingListeners(snapshot)
  return snapshot
}

function notifyWebKeybindingListeners(snapshot: KeybindingFileSnapshot): void {
  for (const listener of webKeybindingListeners) {
    listener(snapshot)
  }
}

function createWebKeybindingsApi(): WebKeybindingsApi {
  return {
    get: () => Promise.resolve(getWebKeybindingSnapshot()),
    ensureFile: () => Promise.resolve(getWebKeybindingSnapshot()),
    setAction: async ({ actionId, bindings }) => writeWebKeybindingAction(actionId, bindings),
    reload: () => {
      const snapshot = getWebKeybindingSnapshot()
      notifyWebKeybindingListeners(snapshot)
      return Promise.resolve(snapshot)
    },
    openFile: () => Promise.resolve(getWebKeybindingSnapshot()),
    revealFile: () => Promise.resolve(getWebKeybindingSnapshot()),
    onChanged: (callback) => {
      webKeybindingListeners.add(callback)
      const onStorage = (event: StorageEvent): void => {
        if (event.key === KEYBINDINGS_STORAGE_KEY) {
          callback(getWebKeybindingSnapshot())
        }
      }
      window.addEventListener('storage', onStorage)
      return () => {
        webKeybindingListeners.delete(callback)
        window.removeEventListener('storage', onStorage)
      }
    }
  }
}

// Why: the desktop reads native-chat transcripts over IPC; the web client has
// no IPC, so route readSession/subscribe through the runtime RPC (the same
// methods the mobile app uses). Without this, window.api.nativeChat was
// undefined on web and the chat view showed no messages.
function createNativeChatApi(): NativeChatApi {
  return {
    readSession: (agent, sessionId, limit, transcriptPath) =>
      callRuntimeResult<NativeChatReadSessionResult>('nativeChat.readSession', {
        agent,
        sessionId,
        limit,
        transcriptPath
      }),
    subscribe: (args, onAppended) => {
      // No paired runtime yet: nothing to subscribe to, and
      // requireActiveEnvironment() would throw. Return a no-op teardown so the
      // chat view mounts cleanly until a runtime is paired (only the not-paired
      // case is swallowed — real subscribe errors still surface via .catch).
      const environment = requireActiveEnvironmentOrNull()
      if (!environment) {
        return () => {}
      }
      let handle: { unsubscribe: () => void } | null = null
      let cancelled = false
      void getClientForEnvironment(environment)
        .subscribe(
          'nativeChat.subscribe',
          { agent: args.agent, sessionId: args.sessionId, transcriptPath: args.transcriptPath },
          {
            onResponse: (response) => {
              if (cancelled || !response.ok) {
                return
              }
              const result = response.result as {
                type?: string
                messages?: NativeChatAppendedMessages
              }
              if (result?.type === 'appended' && Array.isArray(result.messages)) {
                onAppended(result.messages)
              }
            }
          },
          {
            // Why: send nativeChat.unsubscribe on teardown so the server reaps
            // the transcript fs-watcher on view-toggle, not just on socket close
            // (the watcher-leak fix). Uses the same agent:sessionId cleanup token
            // mobile sends, via the shared key-builder so it can't drift.
            buildUnsubscribe: () => buildNativeChatUnsubscribe(args.agent, args.sessionId)
          }
        )
        .then((h) => {
          if (cancelled) {
            h.unsubscribe()
          } else {
            handle = h
          }
        })
        .catch(() => {})
      return () => {
        cancelled = true
        handle?.unsubscribe()
      }
    }
  }
}

function createRuntimeApi(): NonNullable<Partial<PreloadApi>['runtime']> {
  return {
    syncWindowGraph: async (_graph: RuntimeSyncWindowGraph) => getRemoteRuntimeStatus(),
    getStatus: () => getRemoteRuntimeStatus(),
    call: ({ method, params }) => callRuntimeEnvelope(method, params),
    getTerminalFitOverrides: () => Promise.resolve([]),
    getTerminalDrivers: () => Promise.resolve([]),
    getBrowserDrivers: () => Promise.resolve([]),
    restoreTerminalFit: () => Promise.resolve({ restored: false }),
    reclaimBrowserForDesktop: () => Promise.resolve({ reclaimed: false }),
    onTerminalFitOverrideChanged: () => noopUnsubscribe,
    onTerminalDriverChanged: () => noopUnsubscribe,
    onBrowserDriverChanged: () => noopUnsubscribe
  }
}

function createRuntimeEnvironmentsApi(): NonNullable<Partial<PreloadApi>['runtimeEnvironments']> {
  return {
    list: async () => {
      const environment = requireActiveEnvironmentOrNull()
      return environment ? [redactStoredWebRuntimeEnvironment(environment)] : []
    },
    addFromPairingCode: async ({ name, pairingCode }) => {
      const offer = parseWebPairingInput(pairingCode)
      if (!offer) {
        throw new Error('Invalid Orca pairing code.')
      }
      closeActiveRuntimeClients()
      activeEnvironment = createStoredWebRuntimeEnvironment({ name, offer })
      saveStoredWebRuntimeEnvironment(activeEnvironment)
      return { environment: redactStoredWebRuntimeEnvironment(activeEnvironment) }
    },
    resolve: async ({ selector }) =>
      redactStoredWebRuntimeEnvironment(resolveEnvironment(selector)),
    remove: async ({ selector }) => {
      const environment = resolveEnvironment(selector)
      if (activeEnvironment?.id === environment.id) {
        disconnectActiveRuntimeEnvironment()
      }
      return { removed: redactStoredWebRuntimeEnvironment(environment) }
    },
    disconnect: async ({ selector }) => {
      const environment = resolveEnvironment(selector)
      if (activeEnvironment?.id === environment.id) {
        disconnectActiveRuntimeEnvironment()
      }
      return { disconnected: redactStoredWebRuntimeEnvironment(environment) }
    },
    getStatus: ({ selector, timeoutMs }) =>
      callEnvironmentEnvelope<RuntimeStatus>(selector, 'status.get', undefined, timeoutMs),
    call: ({ selector, method, params, timeoutMs }) =>
      callEnvironmentEnvelope(selector, method, params, timeoutMs),
    subscribe: async ({ selector, method, params, timeoutMs }, callbacks) => {
      const environment = resolveEnvironment(selector)
      const client = getClientForEnvironment(environment)
      return client.subscribe(method, params, callbacks, { timeoutMs })
    }
  }
}

function createAiVaultApi(): NonNullable<Partial<PreloadApi>['aiVault']> {
  return {
    listSessions: (args?: AiVaultListArgs) => {
      const environment = requireActiveEnvironment()
      const executionHostId = toRuntimeExecutionHostId(environment.id)
      const requestedScope = normalizeExecutionHostScope(
        args?.executionHostScope ?? executionHostId
      )
      if (requestedScope !== 'all' && requestedScope !== executionHostId) {
        return Promise.resolve(webAiVaultUnavailableResult(requestedScope))
      }
      // Why: the browser client has no local filesystem; every history scan
      // runs on the paired server and must be stamped as that runtime host.
      return callRuntimeResult<AiVaultListResult>('aiVault.listSessions', {
        limit: args?.limit,
        force: args?.force,
        scopePaths: args?.scopePaths,
        executionHostId
      })
    },
    // Why: the runtime RPC surface only exposes aiVault.listSessions; subagent
    // transcript listing has no server-side method yet, so the browser client
    // reports an empty (not erroring) result.
    listSubagentSessions: () => Promise.resolve({ sessions: [], issues: [] }),
    onWindowFocused: () => noopUnsubscribe
  }
}

function webAiVaultUnavailableResult(executionHostId: ExecutionHostId): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        executionHostId,
        agent: 'codex',
        path: executionHostId,
        message: translate(
          'auto.web.webPreloadApi.aiVaultUnavailableForHost',
          'Agent Session History is not available for this execution host.'
        )
      }
    ],
    scannedAt: new Date().toISOString()
  }
}

// ── project-scoped repo bridge (mirrors store/slices/repos.ts's Phase 4b
// fix) ─────────────────────────────────────────────────────────────────
//
// This whole section mirrors store/slices/repos.ts's RemoteRepoView/
// mergeRepoViewIntoRepo/listCallerProjects/fetchAllRemoteRepoViews/
// getOrCreateDefaultProject — a SEPARATE copy, not an import, because this
// file's runtime call plumbing (callRuntimeResult, bound to the one paired
// runtime connection) is a different transport than repos.ts's
// target-parameterized callRuntimeRpc. Found live: this file previously
// reimplemented repo.list/add/update/remove/reorder against the OLD,
// pre-Phase-4b wire shapes ({path, kind} for add, no projectId anywhere,
// a bare RemoteRepoView cast straight to the rich Repo type) — the same
// bug class Phase 4b fixed in repos.ts, never applied here. Keep these two
// copies in sync if either backend shape changes again.
type RemoteRepoView = {
  id: string
  projectId: string
  url: string
  displayName: string
  position: number
  // Not part of the original pre-Phase-10 wire shape this type was copied
  // from — repo.list's response does carry it (channels_repo_ssh_status_
  // workspace.go's toRepoView, json tag devServerId), but this field went
  // silently dropped here since mergeRepoViewIntoRepo below never read it.
  // Found live: "Available Hosts" showing "Local Mac" for every repo
  // fetched through this file's {kind:'local'} leg (the only leg a paired
  // web client ever runs, per fetchReposForAllHosts' own isWebClientLocation
  // guard in store/slices/repos.ts) even after devServerId-aware resolution
  // was fixed there — the field never reached that resolution logic to
  // begin with.
  devServerId?: string
  // hookSettings: JSON-encoded RepoHookSettings (project.proto's
  // Repo.hook_settings). Same "found live" story as devServerId above —
  // repo.update's response carries it, but this file's own copy of
  // mergeRepoViewIntoRepo never read it, so a typed Setup Script silently
  // never persisted for any repo whose window.api.repos.update call landed
  // here (every paired-web-client repo — see this type's own doc comment).
  hookSettings?: string
}

function repoDisplayNameFromUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '')
  const base = trimmed.split('/').findLast(Boolean) || trimmed || url
  return base.replace(/\.git$/, '') || base
}

function parseRepoHookSettings(raw: string | undefined): Repo['hookSettings'] | undefined {
  if (!raw) {
    return undefined
  }
  try {
    return JSON.parse(raw) as Repo['hookSettings']
  } catch {
    return undefined
  }
}

function mergeRepoViewIntoRepo(view: RemoteRepoView, existing?: Repo): Repo {
  return {
    ...existing,
    id: view.id,
    projectId: view.projectId,
    path: view.url,
    displayName: view.displayName || repoDisplayNameFromUrl(view.url),
    badgeColor: existing?.badgeColor ?? '',
    addedAt: existing?.addedAt ?? Date.now(),
    devServerId: view.devServerId ?? existing?.devServerId,
    hookSettings: parseRepoHookSettings(view.hookSettings) ?? existing?.hookSettings
  }
}

async function listCallerProjectIds(): Promise<{ id: string; createdAt: number }[]> {
  const projects = await callRuntimeResult<{ id: string; createdAt: number }[]>('project.list')
  return projects ?? []
}

// fetchAllRemoteRepoViews lists repos across EVERY project the caller
// belongs to, not just a default one — see repos.ts's own doc comment on
// its identically-named function for why (a repo can live in any project
// the caller belongs to, e.g. one created via Project Workspace (Beta)'s
// "New Project" dialog).
async function fetchAllRemoteRepoViews(): Promise<RemoteRepoView[]> {
  const projects = await listCallerProjectIds()
  if (projects.length === 0) {
    return []
  }
  const perProject = await Promise.all(
    projects.map((project) =>
      callRuntimeResult<{ repos: RemoteRepoView[] }>('repo.list', { projectId: project.id }).then(
        (result) => result.repos,
        (err) => {
          console.error(`[web-preload-api] repo.list failed for project ${project.id}:`, err)
          return []
        }
      )
    )
  )
  return perProject.flat()
}

let cachedDefaultProjectId: string | null = null
const DEFAULT_PROJECT_NAME = 'My Repos'

async function getOrCreateDefaultProjectId(): Promise<string> {
  if (cachedDefaultProjectId) {
    return cachedDefaultProjectId
  }
  const projects = await listCallerProjectIds()
  const earliest = projects.slice().sort((a, b) => a.createdAt - b.createdAt)[0]
  if (earliest) {
    cachedDefaultProjectId = earliest.id
    return earliest.id
  }
  const created = await callRuntimeResult<{ id: string }>('project.create', {
    name: DEFAULT_PROJECT_NAME,
    visibility: 'private'
  })
  cachedDefaultProjectId = created.id
  return created.id
}

function createReposApi(): NonNullable<Partial<PreloadApi>['repos']> {
  return {
    list: async () => {
      const views = await fetchAllRemoteRepoViews()
      return views.map((view) => mergeRepoViewIntoRepo(view))
    },
    add: async ({ path }) => {
      invalidateRuntimeWorktreeCaches()
      const projectId = await getOrCreateDefaultProjectId()
      const displayName = repoDisplayNameFromUrl(path)
      // Why a bare RemoteRepoView, not {repo: ...}: channels_repo_ssh_
      // status_workspace.go's repo.add handler returns toRepoView(...)
      // directly — confirmed live (an earlier version of this fix wrapped
      // it and crashed on `result.repo` being undefined).
      const view = await callRuntimeResult<RemoteRepoView>('repo.add', {
        projectId,
        url: path,
        displayName
      })
      return { repo: mergeRepoViewIntoRepo(view) }
    },
    remove: async ({ repoId }) => {
      await callRuntimeResult('repo.rm', { repoId })
      invalidateRuntimeWorktreeCaches()
    },
    // Why: host-scoped forget targets a disconnected/removed SSH host owned by
    // the desktop app. A paired web client talks to a single Orca runtime and
    // has no ghost-host state to reconcile.
    removeForHost: () => {
      throw new Error('Forgetting a host is unavailable in paired web clients.')
    },
    reorder: async ({ orderedIds }) => {
      // Why fetch the repo list first: repo.reorder needs a projectId
      // (Go's ReorderReposRequest is project-scoped, not repo-scoped), which
      // this method's own args don't carry — resolved from whichever repo
      // in orderedIds we can find, same as repos.ts's reorderRepos action.
      const views = await fetchAllRemoteRepoViews()
      const byId = new Map(views.map((view) => [view.id, view]))
      const projectId = orderedIds.map((id) => byId.get(id)?.projectId).find(Boolean) ?? ''
      if (!projectId) {
        return { status: 'rejected' }
      }
      await callRuntimeResult('repo.reorder', { projectId, repoIdsInOrder: orderedIds })
      return { status: 'applied' }
    },
    update: async ({ repoId, updates }) => {
      // Bare RemoteRepoView — see add()'s doc comment above. hookSettings
      // is explicit-presence (only sent when the caller actually touches
      // it — an empty JSON blob is a legitimate "clear it" value, distinct
      // from "don't touch it") — mirrors repos.ts's updateRepo action,
      // which this file's own copy must stay in sync with (see
      // RemoteRepoView's doc comment above).
      const view = await callRuntimeResult<RemoteRepoView>('repo.update', {
        repoId,
        displayName: updates.displayName ?? '',
        ...('hookSettings' in updates
          ? { hookSettings: JSON.stringify(updates.hookSettings ?? {}) }
          : {})
      })
      return mergeRepoViewIntoRepo(view)
    },
    pickFolder: () => Promise.resolve(null),
    pickFolders: () => Promise.resolve([]),
    pickDirectory: () => Promise.resolve(null),
    clone: async ({ url, destination }) => {
      invalidateRuntimeWorktreeCaches()
      return (
        await callRuntimeResult<{ repo: Repo }>('repo.clone', { url, destination }, 10 * 60_000)
      ).repo
    },
    cloneRemote: async () => {
      // Why: SSH relay cloning is owned by the desktop main process; paired web
      // clients must not pretend they can run that local IPC path directly.
      throw new Error('SSH clone is unavailable in paired web clients.')
    },
    createRemote: async () => {
      // Why: SSH relay project creation is owned by the desktop main process;
      // paired web clients cannot create folders through local SSH IPC.
      throw new Error('Creating projects on SSH hosts is unavailable in paired web clients.')
    },
    cloneAbort: () => Promise.resolve(),
    addRemote: async ({ remotePath, displayName }) => {
      invalidateRuntimeWorktreeCaches()
      const projectId = await getOrCreateDefaultProjectId()
      // Bare RemoteRepoView — see add()'s doc comment above.
      const view = await callRuntimeResult<RemoteRepoView>('repo.add', {
        projectId,
        url: remotePath,
        displayName: displayName || repoDisplayNameFromUrl(remotePath)
      })
      return { repo: mergeRepoViewIntoRepo(view) }
    },
    create: async ({ parentPath, name, kind }) => {
      invalidateRuntimeWorktreeCaches()
      return callRuntimeResult('repo.create', { parentPath, name, kind })
    },
    isGitAvailable: async () =>
      (await callRuntimeResult<{ available: boolean }>('repo.gitAvailable')).available,
    getDefaultCreateProjectParent: async () => {
      const result = await callRuntimeResult<{ resolvedPath: string }>('files.browseServerDir', {
        path: '~'
      })
      return getDefaultCreateProjectParent(result.resolvedPath)
    },
    onCloneProgress: () => noopUnsubscribe,
    getGitUsername: () => Promise.resolve(''),
    getBaseRefDefault: async ({ repoId }) => callRuntimeResult('repo.baseRefDefault', { repoId }),
    searchBaseRefs: async ({ repoId, query, limit }) =>
      (
        await callRuntimeResult<{ refs: string[] }>('repo.searchRefs', {
          repoId,
          query,
          limit
        })
      ).refs,
    searchBaseRefDetails: async ({ repoId, query, limit }) => {
      const result = await callRuntimeResult<{
        refs: string[]
        refDetails?: { refName: string; localBranchName: string }[]
      }>('repo.searchRefs', {
        repoId,
        query,
        limit
      })
      return result.refDetails ?? result.refs.map(legacyBaseRefSearchResult)
    },
    onChanged: () => noopUnsubscribe
  }
}

function createWorktreesApi(): NonNullable<Partial<PreloadApi>['worktrees']> {
  return {
    list: async ({ repoId }) =>
      (
        await callRuntimeResult<{ worktrees: Worktree[] }>('worktree.list', {
          repo: repoId,
          limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT
        })
      ).worktrees,
    listDetected: async ({ repoId, projectId }) =>
      callRuntimeDetectedWorktrees(repoId, projectId ?? ''),
    listAll: () => listAllRuntimeWorktrees(),
    create: async (args) => {
      invalidateRuntimeWorktreeCaches()
      return callRuntimeResult('worktree.create', {
        repo: args.repoId,
        name: args.name,
        baseBranch: args.baseBranch,
        compareBaseRef: args.compareBaseRef,
        branchNameOverride: args.branchNameOverride,
        linkedIssue: args.linkedIssue,
        linkedPR: args.linkedPR,
        linkedLinearIssue: args.linkedLinearIssue,
        linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey,
        linkedGitLabIssue: args.linkedGitLabIssue,
        linkedGitLabMR: args.linkedGitLabMR,
        linkedBitbucketPR: args.linkedBitbucketPR,
        linkedAzureDevOpsPR: args.linkedAzureDevOpsPR,
        linkedGiteaPR: args.linkedGiteaPR,
        displayName: args.displayName,
        sparseCheckout: args.sparseCheckout,
        pushTarget: args.pushTarget,
        setupDecision: args.setupDecision,
        createdWithAgent: args.createdWithAgent,
        pendingFirstAgentMessageRename: args.pendingFirstAgentMessageRename,
        ...(args.startup
          ? {
              startupCommand: args.startup.command,
              ...(args.startup.env ? { startupEnv: args.startup.env } : {}),
              ...(args.startup.launchConfig
                ? { startupLaunchConfig: args.startup.launchConfig }
                : {}),
              ...(args.startup.startupCommandDelivery
                ? { startupCommandDelivery: args.startup.startupCommandDelivery }
                : {}),
              activate: true
            }
          : {}),
        parentWorkspace: args.parentWorkspace,
        workspaceStatus: args.workspaceStatus,
        manualOrder: args.manualOrder,
        automationProvenanceRequest: args.automationProvenanceRequest
      })
    },
    // Why: the runtime create path emits no two-phase progress, so the web
    // client's creation panel simply falls back to an indeterminate spinner.
    onCreateProgress: () => noopUnsubscribe,
    prefetchCreateBase: async ({ repoId, baseBranch }) => {
      await callRuntimeResult('worktree.prefetchCreateBase', {
        repo: repoId,
        baseBranch
      })
    },
    resolvePrBase: async ({ repoId, prNumber, headRefName, baseRefName, isCrossRepository }) =>
      callRuntimeResult('worktree.resolvePrBase', {
        repo: repoId,
        prNumber,
        headRefName,
        baseRefName,
        isCrossRepository
      }),
    resolveMrBase: async ({ repoId, mrIid, sourceBranch, targetBranch, isCrossRepository }) =>
      callRuntimeResult('worktree.resolveMrBase', {
        repo: repoId,
        mrIid,
        sourceBranch,
        targetBranch,
        isCrossRepository
      }),
    remove: async ({ worktreeId, force, skipArchive }) => {
      invalidateRuntimeWorktreeCaches()
      return callRuntimeResult<RemoveWorktreeResult>('worktree.rm', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        force,
        runHooks: skipArchive !== true
      })
    },
    // Why: a paired web client's backend connection can pin a workspace to a
    // removed/disconnected SSH host too (BUG-FE-RPC-worktree-forgetLocal) —
    // worktree.forgetLocal clears Orca's own record without touching the
    // (unreachable) remote, same contract as the desktop IPC handler.
    forgetLocal: async ({ worktreeId }) => {
      invalidateRuntimeWorktreeCaches()
      return callRuntimeResult<RemoveWorktreeResult>('worktree.forgetLocal', {
        worktree: toRuntimeWorktreeSelector(worktreeId)
      })
    },
    forceDeletePreservedBranch: ({ worktreeId, branchName, expectedHead }) =>
      callRuntimeResult<ForceDeleteWorktreeBranchResult>('worktree.forceDeleteBranch', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        branchName,
        expectedHead
      }),
    updateMeta: async ({ worktreeId, updates }) => {
      const rpcUpdates =
        Object.prototype.hasOwnProperty.call(updates, 'pushTarget') &&
        updates.pushTarget === undefined
          ? { ...updates, pushTarget: null }
          : updates
      return (
        await callRuntimeResult<{ worktree: Worktree }>('worktree.set', {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          ...rpcUpdates
        })
      ).worktree
    },
    listLineage: async () =>
      await callRuntimeResult<{
        lineage: Record<string, WorktreeLineage>
        workspaceLineage?: Record<string, WorkspaceLineage>
      }>('worktree.lineageList'),
    updateLineage: async ({ worktreeId, parentWorktreeId, noParent }) => {
      invalidateRuntimeWorktreeCaches()
      const result = await callRuntimeResult<{
        worktree: Worktree & { lineage?: WorktreeLineage | null }
      }>('worktree.set', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        parentWorktree: parentWorktreeId,
        noParent
      })
      return result.worktree.lineage ?? null
    },
    persistSortOrder: async ({ orderedIds }) => {
      await callRuntimeResult('worktree.persistSortOrder', { orderedIds })
    },
    // Why: the capture lives in desktop main memory and is not exposed over
    // pairing; the dialog falls back to the persisted excerpt on web clients.
    getBranchRenameFailureOutput: async () => null,
    onChanged: () => noopUnsubscribe,
    onGitStatusMetadataChanged: () => noopUnsubscribe,
    onHeadIdentitiesChanged: () => noopUnsubscribe,
    onBaseStatus: () => noopUnsubscribe,
    onRemoteBranchConflict: () => noopUnsubscribe
  }
}

function createFileApi(): NonNullable<Partial<PreloadApi>['fs']> {
  return {
    readDir: async ({ dirPath }) => {
      const file = await resolveRuntimeFilePath(dirPath)
      return callRuntimeResult<DirEntry[]>('files.readDir', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    readFile: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.readPreview', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    readLocalLogTail: async () => {
      throw new Error('Local log tailing is unavailable in paired web clients.')
    },
    startLocalLogTail: async () => {
      throw new Error('Local log tailing is unavailable in paired web clients.')
    },
    stopLocalLogTail: async () => {},
    onLocalLogTailChanged: () => noopUnsubscribe,
    downloadFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    saveDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    startDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    appendDownloadedFileChunk: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    finishDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    cancelDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    listMarkdownDocuments: async ({ rootPath }) => {
      const file = await resolveRuntimeFilePath(rootPath)
      return callRuntimeResult('files.listMarkdownDocuments', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id)
      })
    },
    writeFile: async ({ filePath, content }) => {
      const file = await resolveRuntimeFilePath(filePath)
      await callRuntimeResult('files.write', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath,
        content
      })
    },
    createFile: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      await callRuntimeResult('files.createFile', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    createDir: async ({ dirPath }) => {
      const file = await resolveRuntimeFilePath(dirPath)
      await callRuntimeResult('files.createDir', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    rename: async ({ oldPath, newPath }) => {
      const oldFile = await resolveRuntimeFilePath(oldPath)
      const newFile = await resolveRuntimeFilePath(newPath)
      await callRuntimeResult('files.rename', {
        worktree: toRuntimeWorktreeSelector(oldFile.worktree.id),
        oldRelativePath: oldFile.relativePath,
        newRelativePath: newFile.relativePath
      })
    },
    copy: async ({ sourcePath, destinationPath }) => {
      const source = await resolveRuntimeFilePath(sourcePath)
      const destination = await resolveRuntimeFilePath(destinationPath)
      await callRuntimeResult('files.copy', {
        worktree: toRuntimeWorktreeSelector(source.worktree.id),
        sourceRelativePath: source.relativePath,
        destinationRelativePath: destination.relativePath
      })
    },
    deletePath: async ({ targetPath, recursive }) => {
      const file = await resolveRuntimeFilePath(targetPath)
      await callRuntimeResult('files.delete', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath,
        recursive
      })
    },
    authorizeExternalPath: () => Promise.resolve(),
    stat: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.stat', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    pathExists: async ({ filePath }) => {
      try {
        const file = await resolveRuntimeFilePath(filePath)
        await callRuntimeResult('files.stat', {
          worktree: toRuntimeWorktreeSelector(file.worktree.id),
          relativePath: file.relativePath
        })
        return true
      } catch (error) {
        if (isMissingPathError(error)) {
          return false
        }
        throw error
      }
    },
    listFiles: async ({ rootPath, excludePaths }) => {
      const file = await resolveRuntimeFilePath(rootPath)
      const result = await callRuntimeResult<{ files: { relativePath: string }[] }>(
        'files.listAll',
        {
          worktree: toRuntimeWorktreeSelector(file.worktree.id),
          excludePaths
        }
      )
      return result.files.map((entry) => entry.relativePath)
    },
    cancelListFiles: async () => {
      // Why: the paired-web path lists files over runtime RPC with its own
      // request timeout; there is no host-side scan to abort from here.
    },
    search: async (args) => {
      const file = await resolveRuntimeFilePath(args.rootPath)
      return callRuntimeResult<SearchResult>('files.search', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        query: args.query,
        caseSensitive: args.caseSensitive,
        wholeWord: args.wholeWord,
        useRegex: args.useRegex,
        includePattern: args.includePattern,
        excludePattern: args.excludePattern,
        maxResults: args.maxResults
      })
    },
    importExternalPaths: async () => ({ results: [] }),
    stageExternalPathsForRuntimeUpload: async () => ({ sources: [] }),
    resolveDroppedPathsForAgent: async () => ({ resolvedPaths: [], skipped: [], failed: [] }),
    watchWorktree: () => Promise.resolve(),
    unwatchWorktree: () => Promise.resolve(),
    onFsChanged: () => noopUnsubscribe
  }
}

function createGitApi(): NonNullable<Partial<PreloadApi>['git']> {
  return {
    status: async ({ worktreePath, includeIgnored }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.status', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        includeIgnored
      })
    },
    submoduleStatus: async ({ worktreePath, submodulePath, area }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.submoduleStatus', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        submodulePath,
        area
      })
    },
    checkIgnored: async ({ worktreePath, paths }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.checkIgnored', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        paths
      })
    },
    // Why: the "add huge folder to .gitignore" flow is a local-desktop helper;
    // in the web runtime there's no offer, so return no candidates / no-op.
    findHugeFoldersToIgnore: async () => [],
    appendGitignore: async () => false,
    history: async ({ worktreePath, limit, baseRef }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.history', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        limit,
        baseRef
      })
    },
    conflictOperation: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.conflictOperation', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    abortMerge: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.abortMerge', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    abortRebase: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.abortRebase', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    diff: async ({ worktreePath, filePath, staged, compareAgainstHead }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.diff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        staged,
        compareAgainstHead
      })
    },
    branchCompare: async ({ worktreePath, baseRef }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.branchCompare', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        baseRef
      })
    },
    commitCompare: async ({ worktreePath, commitId }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.commitCompare', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        commitId
      })
    },
    upstreamStatus: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.upstreamStatus', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    fetch: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.fetch', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    syncFork: async ({ worktreePath, expectedUpstream }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult(
        'git.forkSync',
        {
          worktree: toRuntimeWorktreeSelector(worktree.id),
          expectedUpstream
        },
        60_000
      )
    },
    push: async ({ worktreePath, publish, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.push', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        publish,
        pushTarget
      })
    },
    pull: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.pull', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    fastForward: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.fastForward', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    rebaseFromBase: async ({ worktreePath, baseRef }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.rebaseFromBase', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        baseRef
      })
    },
    branchDiff: async ({ worktreePath, filePath, compare, oldPath }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.branchDiff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        compare,
        oldPath
      })
    },
    commitDiff: async ({ worktreePath, filePath, commitOid, parentOid, oldPath }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.commitDiff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        commitOid,
        parentOid,
        oldPath
      })
    },
    commit: async ({ worktreePath, message }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.commit', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        message
      })
    },
    generateCommitMessage: async () => ({
      success: false,
      error: translate(
        'auto.web.web.preload.api.9fc90740b6',
        'Commit message generation is unavailable in the web client.'
      )
    }),
    discoverCommitMessageModels: async () => ({
      success: false,
      error: translate(
        'auto.web.web.preload.api.e57c82d276',
        'Commit message model discovery is unavailable in the web client.'
      )
    }),
    cancelGenerateCommitMessage: () => Promise.resolve(),
    generatePullRequestFields: async () => ({
      success: false,
      error: translate(
        'auto.web.web.preload.api.b8a1618172',
        'Pull request detail generation is unavailable in the web client.'
      )
    }),
    cancelGeneratePullRequestFields: () => Promise.resolve(),
    stage: async ({ worktreePath, filePath }) => mutateGitPath('git.stage', worktreePath, filePath),
    bulkStage: async ({ worktreePath, filePaths }) =>
      mutateGitPaths('git.bulkStage', worktreePath, filePaths),
    unstage: async ({ worktreePath, filePath }) =>
      mutateGitPath('git.unstage', worktreePath, filePath),
    bulkUnstage: async ({ worktreePath, filePaths }) =>
      mutateGitPaths('git.bulkUnstage', worktreePath, filePaths),
    discard: async ({ worktreePath, filePath }) =>
      mutateGitPath('git.discard', worktreePath, filePath),
    bulkDiscard: async ({ worktreePath, filePaths }) => {
      for (const filePath of filePaths) {
        await mutateGitPath('git.discard', worktreePath, filePath)
      }
    },
    remoteFileUrl: async ({ worktreePath, relativePath, line }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.remoteFileUrl', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        relativePath,
        line
      })
    },
    remoteCommitUrl: async ({ worktreePath, sha }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.remoteCommitUrl', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        sha
      })
    }
  }
}

function createBrowserApi(): NonNullable<Partial<PreloadApi>['browser']> {
  return {
    registerGuest: () => Promise.resolve(),
    unregisterGuest: () => Promise.resolve(),
    openDevTools: () => Promise.resolve(false),
    setViewportOverride: () => Promise.resolve(false),
    setAnnotationViewportBridge: () => Promise.resolve(false),
    onGuestLoadFailed: () => noopUnsubscribe,
    onPermissionDenied: () => noopUnsubscribe,
    onPopup: () => noopUnsubscribe,
    onDownloadRequested: () => noopUnsubscribe,
    onDownloadProgress: () => noopUnsubscribe,
    onDownloadFinished: () => noopUnsubscribe,
    onContextMenuRequested: () => noopUnsubscribe,
    onContextMenuDismissed: () => noopUnsubscribe,
    onNavigationUpdate: () => noopUnsubscribe,
    onActivateView: () => noopUnsubscribe,
    onPaneFocus: () => noopUnsubscribe,
    onOpenLinkInOrcaTab: () => noopUnsubscribe,
    cancelDownload: () => Promise.resolve(false),
    setGrabMode: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.31bea294d5',
          'Grab mode is unavailable in the web client.'
        )
      }),
    awaitGrabSelection: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.31bea294d5',
          'Grab mode is unavailable in the web client.'
        )
      }),
    cancelGrab: () => Promise.resolve(false),
    captureSelectionScreenshot: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.8dfcb7a351',
          'Selection screenshots are unavailable in the web client.'
        )
      }),
    extractHoverPayload: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.275a776357',
          'Hover extraction is unavailable in the web client.'
        )
      }),
    onGrabModeToggle: () => noopUnsubscribe,
    onGrabActionShortcut: () => noopUnsubscribe,
    sessionListProfiles: () => Promise.resolve([]),
    sessionCreateProfile: () => Promise.resolve(null),
    sessionDeleteProfile: () => Promise.resolve(false),
    sessionImportCookies: () =>
      Promise.resolve({
        ok: false,
        summary: null,
        error: translate(
          'auto.web.web.preload.api.67ec964791',
          'Cookie import is unavailable in the web client.'
        )
      }),
    sessionResolvePartition: () => Promise.resolve(null),
    sessionDetectBrowsers: () => Promise.resolve([]),
    sessionImportFromBrowser: () =>
      Promise.resolve({
        ok: false,
        summary: null,
        error: translate(
          'auto.web.web.preload.api.67ec964791',
          'Cookie import is unavailable in the web client.'
        )
      }),
    sessionClearDefaultCookies: () => Promise.resolve(false),
    notifyActiveTabChanged: () => Promise.resolve(false)
  } as unknown as NonNullable<Partial<PreloadApi>['browser']>
}

function createEmulatorApi(): NonNullable<Partial<PreloadApi>['emulator']> {
  return {
    onPaneFocus: () => noopUnsubscribe,
    onAutoAttach: () => noopUnsubscribe,
    startFrameStream: () => Promise.reject(new Error('Mobile emulator is unavailable on web.')),
    stopFrameStream: () => Promise.resolve(),
    onFrameStreamFrame: () => noopUnsubscribe,
    onFrameStreamError: () => noopUnsubscribe
  } as unknown as NonNullable<Partial<PreloadApi>['emulator']>
}

function createGitHubApi(): WebGitHubApi {
  const route = <Result>(method: WebGitHubRuntimeMethod, args?: unknown): Promise<Result> =>
    callRuntimeResult<Result>(method, mapRepoPathArg(args))
  const githubApi = {
    viewer: () => Promise.resolve(null),
    repoSlug: (args) => route<WebGitHubResult<'repoSlug'>>(GITHUB_WEB_RPC_METHODS.repoSlug, args),
    repoUpstream: (args) =>
      route<WebGitHubResult<'repoUpstream'>>(GITHUB_WEB_RPC_METHODS.repoUpstream, args),
    prForBranch: (args) =>
      route<WebGitHubResult<'prForBranch'>>(GITHUB_WEB_RPC_METHODS.prForBranch, args),
    refreshPRNow: async ({ candidate }) => {
      const acceptMergedFallbackPR =
        candidate.linkedPRNumber == null &&
        candidate.fallbackPRNumber != null &&
        candidate.fallbackPRSource != null
      const pr = await route<WebGitHubResult<'prForBranch'>>(GITHUB_WEB_RPC_METHODS.prForBranch, {
        repoPath: candidate.repoPath,
        repoId: candidate.repoId,
        branch: candidate.branch,
        linkedPRNumber: candidate.linkedPRNumber ?? null,
        fallbackPRNumber: candidate.fallbackPRNumber ?? null,
        currentHeadOid: candidate.currentHeadOid ?? null,
        ...(acceptMergedFallbackPR ? { acceptMergedFallbackPR: true } : {})
      })
      return pr
        ? { kind: 'found', pr, fetchedAt: Date.now() }
        : { kind: 'no-pr', fetchedAt: Date.now() }
    },
    enqueuePRRefresh: () => Promise.resolve(false),
    reportVisiblePRRefreshCandidates: () => Promise.resolve(false),
    onPRRefreshEvent: () => noopUnsubscribe,
    issue: (args) => route<WebGitHubResult<'issue'>>(GITHUB_WEB_RPC_METHODS.issue, args),
    workItem: (args) => route<WebGitHubResult<'workItem'>>(GITHUB_WEB_RPC_METHODS.workItem, args),
    workItemByOwnerRepo: ({ repo: ownerRepo, ...args }) =>
      route<WebGitHubResult<'workItemByOwnerRepo'>>(GITHUB_WEB_RPC_METHODS.workItemByOwnerRepo, {
        ...args,
        ownerRepo
      }),
    workItemDetails: (args) =>
      route<WebGitHubResult<'workItemDetails'>>(GITHUB_WEB_RPC_METHODS.workItemDetails, args),
    notifyWorkItemMutated: () => Promise.resolve(false),
    prFileContents: (args) =>
      route<WebGitHubResult<'prFileContents'>>(GITHUB_WEB_RPC_METHODS.prFileContents, args),
    listIssues: (args) =>
      route<WebGitHubResult<'listIssues'>>(GITHUB_WEB_RPC_METHODS.listIssues, args),
    createIssue: (args) =>
      route<WebGitHubResult<'createIssue'>>(GITHUB_WEB_RPC_METHODS.createIssue, args),
    countWorkItems: (args) =>
      route<WebGitHubResult<'countWorkItems'>>(GITHUB_WEB_RPC_METHODS.countWorkItems, args),
    listWorkItems: (args) =>
      route<WebGitHubResult<'listWorkItems'>>(GITHUB_WEB_RPC_METHODS.listWorkItems, args),
    prChecks: (args) => route<WebGitHubResult<'prChecks'>>(GITHUB_WEB_RPC_METHODS.prChecks, args),
    prCheckDetails: (args) =>
      route<WebGitHubResult<'prCheckDetails'>>(GITHUB_WEB_RPC_METHODS.prCheckDetails, args),
    rerunPRChecks: (args) =>
      route<WebGitHubResult<'rerunPRChecks'>>(GITHUB_WEB_RPC_METHODS.rerunPRChecks, args),
    prComments: (args) =>
      route<WebGitHubResult<'prComments'>>(GITHUB_WEB_RPC_METHODS.prComments, args),
    resolveReviewThread: (args) =>
      route<WebGitHubResult<'resolveReviewThread'>>(
        GITHUB_WEB_RPC_METHODS.resolveReviewThread,
        args
      ),
    setPRFileViewed: (args) =>
      route<WebGitHubResult<'setPRFileViewed'>>(GITHUB_WEB_RPC_METHODS.setPRFileViewed, args),
    updatePRTitle: (args) =>
      route<WebGitHubResult<'updatePRTitle'>>(GITHUB_WEB_RPC_METHODS.updatePRTitle, args),
    mergePR: (args) => route<WebGitHubResult<'mergePR'>>(GITHUB_WEB_RPC_METHODS.mergePR, args),
    setPRAutoMerge: (args) =>
      route<WebGitHubResult<'setPRAutoMerge'>>(GITHUB_WEB_RPC_METHODS.setPRAutoMerge, args),
    updatePRState: (args) =>
      route<WebGitHubResult<'updatePRState'>>(GITHUB_WEB_RPC_METHODS.updatePRState, args),
    requestPRReviewers: (args) =>
      route<WebGitHubResult<'requestPRReviewers'>>(GITHUB_WEB_RPC_METHODS.requestPRReviewers, args),
    removePRReviewers: (args) =>
      route<WebGitHubResult<'removePRReviewers'>>(GITHUB_WEB_RPC_METHODS.removePRReviewers, args),
    updateIssue: (args) =>
      route<WebGitHubResult<'updateIssue'>>(GITHUB_WEB_RPC_METHODS.updateIssue, args),
    addIssueComment: (args) =>
      route<WebGitHubResult<'addIssueComment'>>(GITHUB_WEB_RPC_METHODS.addIssueComment, args),
    addPRReviewCommentReply: (args) =>
      route<WebGitHubResult<'addPRReviewCommentReply'>>(
        GITHUB_WEB_RPC_METHODS.addPRReviewCommentReply,
        args
      ),
    addPRReviewComment: (args) =>
      route<WebGitHubResult<'addPRReviewComment'>>(GITHUB_WEB_RPC_METHODS.addPRReviewComment, args),
    listLabels: (args) =>
      route<WebGitHubResult<'listLabels'>>(GITHUB_WEB_RPC_METHODS.listLabels, args),
    listAssignableUsers: (args) =>
      route<WebGitHubResult<'listAssignableUsers'>>(
        GITHUB_WEB_RPC_METHODS.listAssignableUsers,
        args
      ),
    onWorkItemMutated: () => noopUnsubscribe,
    checkOrcaStarred: () => Promise.resolve(null),
    starOrca: () => Promise.resolve(false),
    rateLimit: (args) =>
      route<WebGitHubResult<'rateLimit'>>(GITHUB_WEB_RPC_METHODS.rateLimit, args),
    diagnoseAuth: () =>
      Promise.resolve({
        ok: false,
        message: translate('auto.web.web.preload.api.31bfe8ae1a', 'Unavailable in the web client.')
      } as never),
    listAccessibleProjects: () =>
      route<WebGitHubResult<'listAccessibleProjects'>>(
        GITHUB_WEB_RPC_METHODS.listAccessibleProjects
      ),
    resolveProjectRef: (args) =>
      route<WebGitHubResult<'resolveProjectRef'>>(GITHUB_WEB_RPC_METHODS.resolveProjectRef, args),
    listProjectViews: (args) =>
      route<WebGitHubResult<'listProjectViews'>>(GITHUB_WEB_RPC_METHODS.listProjectViews, args),
    getProjectViewTable: (args) =>
      route<WebGitHubResult<'getProjectViewTable'>>(
        GITHUB_WEB_RPC_METHODS.getProjectViewTable,
        args
      ),
    projectWorkItemDetailsBySlug: (args) =>
      route<WebGitHubResult<'projectWorkItemDetailsBySlug'>>(
        GITHUB_WEB_RPC_METHODS.projectWorkItemDetailsBySlug,
        args
      ),
    updateProjectItemField: (args) =>
      route<WebGitHubResult<'updateProjectItemField'>>(
        GITHUB_WEB_RPC_METHODS.updateProjectItemField,
        args
      ),
    clearProjectItemField: (args) =>
      route<WebGitHubResult<'clearProjectItemField'>>(
        GITHUB_WEB_RPC_METHODS.clearProjectItemField,
        args
      ),
    updateIssueBySlug: (args) =>
      route<WebGitHubResult<'updateIssueBySlug'>>(GITHUB_WEB_RPC_METHODS.updateIssueBySlug, args),
    updatePullRequestBySlug: (args) =>
      route<WebGitHubResult<'updatePullRequestBySlug'>>(
        GITHUB_WEB_RPC_METHODS.updatePullRequestBySlug,
        args
      ),
    addIssueCommentBySlug: (args) =>
      route<WebGitHubResult<'addIssueCommentBySlug'>>(
        GITHUB_WEB_RPC_METHODS.addIssueCommentBySlug,
        args
      ),
    updateIssueCommentBySlug: (args) =>
      route<WebGitHubResult<'updateIssueCommentBySlug'>>(
        GITHUB_WEB_RPC_METHODS.updateIssueCommentBySlug,
        args
      ),
    deleteIssueCommentBySlug: (args) =>
      route<WebGitHubResult<'deleteIssueCommentBySlug'>>(
        GITHUB_WEB_RPC_METHODS.deleteIssueCommentBySlug,
        args
      ),
    listLabelsBySlug: (args) =>
      route<WebGitHubResult<'listLabelsBySlug'>>(GITHUB_WEB_RPC_METHODS.listLabelsBySlug, args),
    listAssignableUsersBySlug: (args) =>
      route<WebGitHubResult<'listAssignableUsersBySlug'>>(
        GITHUB_WEB_RPC_METHODS.listAssignableUsersBySlug,
        args
      ),
    listIssueTypesBySlug: (args) =>
      route<WebGitHubResult<'listIssueTypesBySlug'>>(
        GITHUB_WEB_RPC_METHODS.listIssueTypesBySlug,
        args
      ),
    updateIssueTypeBySlug: (args) =>
      route<WebGitHubResult<'updateIssueTypeBySlug'>>(
        GITHUB_WEB_RPC_METHODS.updateIssueTypeBySlug,
        args
      )
  } satisfies WebGitHubApi

  return githubApi
}

function createGitLabApi(): WebGitLabApi {
  const route = <Result>(method: WebGitLabRuntimeMethod, args?: unknown): Promise<Result> =>
    callRuntimeResult<Result>(method, mapRepoPathArg(args))

  const gitLabApi = {
    viewer: () => Promise.resolve(null),
    diagnoseAuth: () => route<WebGitLabResult<'diagnoseAuth'>>(GITLAB_WEB_RPC_METHODS.diagnoseAuth),
    rateLimit: (args) =>
      route<WebGitLabResult<'rateLimit'>>(GITLAB_WEB_RPC_METHODS.rateLimit, args),
    projectSlug: () => Promise.resolve(null),
    mrForBranch: () => Promise.resolve(null),
    mr: () => Promise.resolve(null),
    listMRs: (args) => route<WebGitLabResult<'listMRs'>>(GITLAB_WEB_RPC_METHODS.listMRs, args),
    listWorkItems: (args) =>
      route<WebGitLabResult<'listWorkItems'>>(GITLAB_WEB_RPC_METHODS.listWorkItems, args),
    issue: () => Promise.resolve(null),
    listIssues: (args) =>
      route<WebGitLabResult<'listIssues'>>(GITLAB_WEB_RPC_METHODS.listIssues, args),
    createIssue: (args) =>
      route<WebGitLabResult<'createIssue'>>(GITLAB_WEB_RPC_METHODS.createIssue, args),
    updateIssue: (args) =>
      route<WebGitLabResult<'updateIssue'>>(GITLAB_WEB_RPC_METHODS.updateIssue, args),
    addIssueComment: (args) =>
      route<WebGitLabResult<'addIssueComment'>>(GITLAB_WEB_RPC_METHODS.addIssueComment, args),
    listLabels: (args) =>
      route<WebGitLabResult<'listLabels'>>(GITLAB_WEB_RPC_METHODS.listLabels, args),
    listAssignableUsers: () => Promise.resolve([]),
    todos: (args) => route<WebGitLabResult<'todos'>>(GITLAB_WEB_RPC_METHODS.todos, args),
    workItemDetails: (args) =>
      route<WebGitLabResult<'workItemDetails'>>(GITLAB_WEB_RPC_METHODS.workItemDetails, args),
    closeMR: (args) =>
      route<WebGitLabResult<'closeMR'>>(GITLAB_WEB_RPC_METHODS.closeMR, {
        ...args,
        state: 'closed'
      }),
    reopenMR: (args) =>
      route<WebGitLabResult<'reopenMR'>>(GITLAB_WEB_RPC_METHODS.reopenMR, {
        ...args,
        state: 'opened'
      }),
    mergeMR: (args) => route<WebGitLabResult<'mergeMR'>>(GITLAB_WEB_RPC_METHODS.mergeMR, args),
    updateMR: (args) => route<WebGitLabResult<'updateMR'>>(GITLAB_WEB_RPC_METHODS.updateMR, args),
    updateMRReviewers: (args) =>
      route<WebGitLabResult<'updateMRReviewers'>>(GITLAB_WEB_RPC_METHODS.updateMRReviewers, args),
    addMRComment: (args) =>
      route<WebGitLabResult<'addMRComment'>>(GITLAB_WEB_RPC_METHODS.addMRComment, args),
    addMRInlineComment: (args) =>
      route<WebGitLabResult<'addMRInlineComment'>>(GITLAB_WEB_RPC_METHODS.addMRInlineComment, args),
    resolveMRDiscussion: (args) =>
      route<WebGitLabResult<'resolveMRDiscussion'>>(
        GITLAB_WEB_RPC_METHODS.resolveMRDiscussion,
        args
      ),
    jobTrace: (args) => route<WebGitLabResult<'jobTrace'>>(GITLAB_WEB_RPC_METHODS.jobTrace, args),
    retryJob: (args) => route<WebGitLabResult<'retryJob'>>(GITLAB_WEB_RPC_METHODS.retryJob, args),
    workItemByPath: (args) =>
      route<WebGitLabResult<'workItemByPath'>>(GITLAB_WEB_RPC_METHODS.workItemByPath, args)
  } satisfies WebGitLabApi

  return gitLabApi
}

function createRuntimeNamespaceApi(prefix: string): never {
  return createFallbackProxy([prefix], (path, args) => {
    const method = `${prefix}.${path.at(-1) ?? ''}`
    return callRuntimeResult(method, mapRuntimeNamespaceArg(prefix, args[0]))
  }) as never
}

// ─── Dev Server Web API ───────────────────────────────────────────────────────
// Bridges the DevServer CRUD + status subscription to the runtime RPC layer.
// In web mode (browser) there is no Electron IPC, so all calls go through
// callRuntimeResult (WebSocket → Orca server process).
function createDevServerApi(): NonNullable<Partial<PreloadApi>['devServer']> {
  type StatusHandler = (event: {
    id: string
    status: DevServerStatus
    platform?: NodeJS.Platform
    error?: string
  }) => void

  const statusHandlers = new Set<StatusHandler>()

  // Subscribe to push events from the runtime for devServer status changes.
  // Poll via devServer.list at regular intervals as a fallback since push events
  // are not yet plumbed through the client-events stream in web mode.
  let statusSubscribed = false
  function ensureStatusSubscription(): void {
    if (statusSubscribed) {
      return
    }
    statusSubscribed = true

    const poll = (): void => {
      void callRuntimeResult<DevServer[]>('devServer.list')
        .then((servers) => {
          for (const server of servers) {
            // Emit full status event so updateDevServerStatus gets arch/nodeVersion/error too
            for (const handler of statusHandlers) {
              handler({
                id: server.id,
                status: server.status,
                platform: server.platform ?? undefined,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                arch: (server as any).arch ?? undefined,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                nodeVersion: (server as any).nodeVersion ?? undefined,
                error: server.lastError ?? undefined
              })
            }
          }
        })
        .catch(() => {})
    }

    // First poll after short delay (agents may reconnect quickly after container restart)
    setTimeout(poll, 1_500)
    // Then poll every 3s for live updates
    setInterval(poll, 3_000)
  }

  return {
    // CR-DS-009: `filter` is forwarded as-is; today's api-gateway
    // `devServer.list` wscompat channel does not yet read a `kind` arg or
    // return a `kind` field (TASK-EMU-009's scope stopped at emulator.*
    // routing, not this channel) — passing it is forward-compatible and a
    // harmless no-op until that channel is updated, never a regression.
    list: (filter?: DevServerListFilter) =>
      callRuntimeResult<DevServer[]>('devServer.list', filter),

    add: (input) => callRuntimeResult<DevServer>('devServer.add', input),

    remove: (id) => callRuntimeResult<void>('devServer.remove', { id }),

    connect: (id) => callRuntimeResult<DevServer>('devServer.connect', { id }),

    disconnect: (id) => callRuntimeResult<void>('devServer.disconnect', { id }),

    testConnection: (input) =>
      callRuntimeResult<ConnectionTestResult>('devServer.testConnection', input),

    listSshTargets: async () => {
      const result = await callRuntimeResult<{ targets: SshTarget[] }>('devServer.listSshTargets')
      return result.targets
    },

    addSshTarget: async (params) => {
      const result = await callRuntimeResult<{ target: SshTarget }>(
        'devServer.addSshTarget',
        params
      )
      return result.target
    },

    onStatusChanged: (handler) => {
      statusHandlers.add(handler)
      ensureStatusSubscription()
      return () => {
        statusHandlers.delete(handler)
      }
    },

    onAgentToken: () => noopUnsubscribe,
    offAgentToken: () => {},

    browseDir: async ({ id, path }) => {
      return callRuntimeResult<{
        resolvedPath: string
        entries: { name: string; isDirectory: boolean; isSymlink: boolean }[]
      }>('devServer.browseDir', { id, path })
    },
    mkdir: async ({ id, path }) => {
      return callRuntimeResult<{ path: string }>('devServer.mkdir', { id, path })
    },
    rmdir: async ({ id, path }) => {
      return callRuntimeResult<void>('devServer.rmdir', { id, path })
    },

    // ── CR-DS-006/007/008: admin approval, grouping, department access ──
    // Why devServerId, not id: the wscompat channel handlers
    // (channels_dev_server_access_control.go) decode this key as
    // `devServerId` — live-verified bug: sending `{ id }` here left the
    // backend's DevServerID empty (no matching JSON key), so
    // ApproveDevServer's WHERE id = '' matched no row and failed with
    // INFRA_APPROVE_DEV_SERVER_FAILED regardless of which server was
    // clicked.
    approve: (id) => callRuntimeResult<DevServer>('devServer.approve', { devServerId: id }),
    reject: (id, reason) =>
      callRuntimeResult<DevServer>('devServer.reject', { devServerId: id, reason }),
    assignGroup: (id, groupId) =>
      callRuntimeResult<DevServer>('devServer.assignGroup', { devServerId: id, groupId }),
    listForUser: async (filter?: DevServerListFilter) => {
      // Why the unwrap: devServer.listForUser's wscompat handler returns
      // {devServers: [...]}, not a bare array — same wrapped-object
      // convention as devServerGroup.list/.listGrants and
      // devServer.listPendingAccessRequests below (matches
      // listSshTargets/addSshTarget's existing unwrap above). Live-verified
      // bug: without this, `groups`/`devServers` etc. were the wrapper
      // object itself, and every `.map()` call downstream crashed with
      // "t.map is not a function".
      // CR-DS-009: `filter` forwarding has the same forward-compatible,
      // currently-a-no-op status as devServer.list above.
      const result = await callRuntimeResult<{
        devServers: DevServer[]
      }>('devServer.listForUser', filter)
      return result.devServers
    },
    requestAccess: (params) =>
      callRuntimeResult<DevServerAccessRequest>('devServer.requestAccess', params),
    listPendingAccessRequests: async () => {
      const result = await callRuntimeResult<{
        requests: DevServerAccessRequest[]
      }>('devServer.listPendingAccessRequests')
      return result.requests
    },
    resolveAccessRequest: (params) =>
      callRuntimeResult<{
        request: DevServerAccessRequest
        grant: DevServerGroupGrant | null
      }>('devServer.resolveAccessRequest', params)
  } as NonNullable<Partial<PreloadApi>['devServer']>
}

// ─── Dev Server Group Web API (CR-DS-006/007) ─────────────────────────────
function createDevServerGroupApi(): NonNullable<Partial<PreloadApi>['devServerGroup']> {
  return {
    create: (params) => callRuntimeResult<DevServerGroup>('devServerGroup.create', params),
    list: async () => {
      // Why the unwrap: see devServer.listForUser's comment above — same
      // {groups: [...]} wrapped-object convention, not a bare array.
      const result = await callRuntimeResult<{
        groups: DevServerGroup[]
      }>('devServerGroup.list')
      return result.groups
    },
    grant: (params) => callRuntimeResult<DevServerGroupGrant>('devServerGroup.grant', params),
    revoke: (grantId) => callRuntimeResult<void>('devServerGroup.revoke', { grantId }),
    listGrants: async (devServerGroupId) => {
      const result = await callRuntimeResult<{
        grants: DevServerGroupGrant[]
      }>('devServerGroup.listGrants', { devServerGroupId })
      return result.grants
    }
  }
}

// ─── Tenant Profile Web API (CR-DS-008 Department Gate) ───────────────────
// Bridges to the pre-existing tenant-service profile.* wscompat channels
// (profile.getUserProfile / profile.listDepts / profile.updateUser) — not
// the unrelated renderer/src/hooks/useProfile.ts (TDD-FE-11's OrcaProfile
// settings-hierarchy feature, which reuses the same channel names for a
// different payload shape).
function createTenantProfileApi(): NonNullable<Partial<PreloadApi>['tenantProfile']> {
  return {
    getUserProfile: () => callRuntimeResult<TenantUserProfile>('profile.getUserProfile'),
    listDepartments: () => callRuntimeResult<TenantDepartment[]>('profile.listDepts'),
    setUserDepartment: ({ departmentId }) =>
      callRuntimeResult<TenantUserProfile>('profile.updateUser', {
        departmentId,
        clearDepartment: false
      }),
    setUserDepartmentFor: ({ userId, departmentId }) =>
      callRuntimeResult<TenantUserProfile>('profile.updateUser', {
        userId,
        departmentId,
        clearDepartment: false
      }),
    getCompany: (params) => callRuntimeResult<TenantCompany>('profile.getCompany', params ?? {}),
    updateCompany: (params) => callRuntimeResult<TenantCompany>('profile.updateCompany', params),
    createCompany: (params) => callRuntimeResult<TenantCompany>('profile.createCompany', params),
    listCompanies: async () => {
      const result = await callRuntimeResult<{
        companies: TenantCompany[]
      }>('profile.listCompanies')
      return result.companies
    },
    createDepartment: ({ name, companyId }) =>
      callRuntimeResult<TenantDepartment>('profile.createDept', { name, companyId })
  }
}

// ─── Admin User Management Web API ────────────────────────────────────────
// Bridges to auth-service's user-management RPCs via the new admin.*
// wscompat channels (channels_admin_users.go) — admin-gated server-side.
function createAdminApi(): NonNullable<Partial<PreloadApi>['admin']> {
  return {
    createUser: (params) =>
      callRuntimeResult<{
        user: AdminUser
        generatedPassword: string
      }>('admin.createUser', params),
    listUsers: (params) =>
      callRuntimeResult<{
        users: AdminUser[]
        nextPageToken: string
      }>('admin.listUsers', params ?? {}),
    updateUserRole: (params) => callRuntimeResult<AdminUser>('admin.updateUserRole', params),
    deactivateUser: (params) => callRuntimeResult<AdminUser>('admin.deactivateUser', params),
    reactivateUser: (params) => callRuntimeResult<AdminUser>('admin.reactivateUser', params)
  }
}

function createHooksApi(): NonNullable<Partial<PreloadApi>['hooks']> {
  return {
    check: async ({ repoId }) => callRuntimeResult('repo.hooksCheck', { repo: repoId }),
    inspectSetupScriptImports: async ({ repoId }) =>
      callRuntimeResult('repo.setupScriptImports', { repo: repoId }),
    createIssueCommandRunner: async () => ({ launched: false }) as never,
    readIssueCommand: async ({ repoId }) =>
      callRuntimeResult('repo.issueCommandRead', { repo: repoId }),
    writeIssueCommand: async ({ repoId, content }) => {
      await callRuntimeResult('repo.issueCommandWrite', { repo: repoId, content })
    }
  }
}

function createWebUiApi(): NonNullable<Partial<PreloadApi>['ui']> {
  let zoomLevel = readLocalWebUIState().uiZoomLevel
  return {
    get: async () => {
      try {
        const result = await callRuntimeResult<{ ui: PersistedUIState }>(
          'ui.get',
          undefined,
          15_000
        )
        const local = readLocalWebUIState()
        const next = {
          ...mergeWebUIState(local, result.ui),
          featureInteractions: mergeFeatureInteractionState(
            local.featureInteractions,
            result.ui.featureInteractions
          ),
          contextualToursSeenIds: mergeContextualTourSeenIds(
            local.contextualToursSeenIds,
            result.ui.contextualToursSeenIds
          )
        }
        writeJson(UI_STORAGE_KEY, next)
        zoomLevel = next.uiZoomLevel
        return next
      } catch {
        return readLocalWebUIState()
      }
    },
    set: async (updates) => {
      const next = mergeWebUIState(readLocalWebUIState(), updates)
      writeJson(UI_STORAGE_KEY, next)
      zoomLevel = next.uiZoomLevel
      try {
        await callRuntimeResult('ui.set', updates, 15_000)
      } catch {
        // Why: unpaired/offline web clients still need local UI persistence.
      }
    },
    recordFeatureInteraction: async (id: FeatureInteractionId) => {
      const current = readLocalWebUIState()
      const featureInteractions = normalizeFeatureInteractions(current.featureInteractions)
      const existing = featureInteractions[id]
      const optimistic = mergeWebUIState(current, {
        featureInteractions: {
          ...featureInteractions,
          [id]: {
            firstInteractedAt: existing?.firstInteractedAt ?? Date.now(),
            interactionCount: (existing?.interactionCount ?? 0) + 1
          }
        }
      })
      writeJson(UI_STORAGE_KEY, optimistic)
      try {
        const result = await callRuntimeResult<{ ui: PersistedUIState }>(
          'ui.recordFeatureInteraction',
          id,
          15_000
        )
        const local = readLocalWebUIState()
        const next = {
          ...mergeWebUIState(local, result.ui),
          featureInteractions: mergeFeatureInteractionState(
            local.featureInteractions,
            result.ui.featureInteractions
          ),
          contextualToursSeenIds: mergeContextualTourSeenIds(
            local.contextualToursSeenIds,
            result.ui.contextualToursSeenIds
          )
        }
        writeJson(UI_STORAGE_KEY, next)
        zoomLevel = next.uiZoomLevel
        return next
      } catch {
        return optimistic
      }
    },
    readClipboardText: async (options?: ReadClipboardTextOptions) =>
      assertClipboardTextWithinLimitWithYield(
        await (navigator.clipboard?.readText?.() ?? ''),
        options
      ),
    readSelectionClipboardText: () =>
      Promise.reject(new Error('Selection clipboard is unavailable in the web client')),
    saveClipboardImageAsTempFile: async (args?: {
      connectionId?: string | null
      runtimeEnvironmentId?: string | null
    }) => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      const contentBase64 = await readClipboardImagePngBase64()
      if (!contentBase64) {
        return null
      }
      return saveClipboardImageAsTempFileInRuntime(contentBase64, args)
    },
    writeClipboardText: async (text) => {
      await assertClipboardTextWriteWithinLimitWithYield(text)
      await (navigator.clipboard?.writeText?.(text) ?? Promise.resolve())
    },
    writeSelectionClipboardText: () =>
      Promise.reject(new Error('Selection clipboard is unavailable in the web client')),
    writeClipboardImage: () => Promise.resolve(),
    writeClipboardFile: () => Promise.resolve({ ok: false, reason: 'unsupported-platform' }),
    performNativePaste: () => {
      document.execCommand?.('paste')
    },
    onExportPdfRequested: () => noopUnsubscribe,
    onAppMenuPaste: () => noopUnsubscribe,
    onEditableContextPaste: () => noopUnsubscribe,
    getZoomLevel: () => zoomLevel,
    setZoomLevel: (level) => {
      zoomLevel = level
    },
    isMaximized: () => Promise.resolve(false),
    onOpenSettings: () => noopUnsubscribe,
    onOpenSetupGuide: () => noopUnsubscribe,
    onOpenFeatureTour: () => noopUnsubscribe,
    onOpenCrashReport: () => noopUnsubscribe,
    // No desktop main process to push state changes; the web client re-reads
    // via ui.get on interaction instead.
    onStateChanged: () => noopUnsubscribe,
    onToggleLeftSidebar: () => noopUnsubscribe,
    onToggleRightSidebar: () => noopUnsubscribe,
    onToggleWorktreePalette: () => noopUnsubscribe,
    onToggleFloatingTerminal: () => noopUnsubscribe,
    onTerminalShortcutCaptured: () => noopUnsubscribe,
    onOpenQuickOpen: () => noopUnsubscribe,
    onToggleQuickCommandsMenu: () => noopUnsubscribe,
    onOpenTasks: () => noopUnsubscribe,
    onOpenNewWorkspace: () => noopUnsubscribe,
    onDeleteCurrentWorkspace: () => noopUnsubscribe,
    onOpenWorkspaceBoard: () => noopUnsubscribe,
    onJumpToWorktreeIndex: () => noopUnsubscribe,
    onJumpToTabIndex: () => noopUnsubscribe,
    onWorktreeHistoryNavigate: () => noopUnsubscribe,
    onNewBrowserTab: () => noopUnsubscribe,
    onNewMarkdownTab: () => noopUnsubscribe,
    onNewSimulatorTab: () => noopUnsubscribe,
    onRequestTabCreate: () => noopUnsubscribe,
    replyTabCreate: () => {},
    onRequestTabSetProfile: () => noopUnsubscribe,
    replyTabSetProfile: () => {},
    onRequestTabClose: () => noopUnsubscribe,
    replyTabClose: () => {},
    onNewTerminalTab: () => noopUnsubscribe,
    onFocusBrowserAddressBar: () => noopUnsubscribe,
    onFindInBrowserPage: () => noopUnsubscribe,
    onReloadBrowserPage: () => noopUnsubscribe,
    onBrowserHistoryNavigate: () => noopUnsubscribe,
    onZoomBrowserPage: () => noopUnsubscribe,
    onHardReloadBrowserPage: () => noopUnsubscribe,
    onCloseActiveTab: () => noopUnsubscribe,
    onSwitchTab: () => noopUnsubscribe,
    onSwitchTabAcrossAllTypes: () => noopUnsubscribe,
    onSwitchRecentTab: () => noopUnsubscribe,
    onSwitchTerminalTab: () => noopUnsubscribe,
    onCtrlTabKeyDown: () => noopUnsubscribe,
    onCtrlTabKeyUp: () => noopUnsubscribe,
    onToggleStatusBar: () => noopUnsubscribe,
    onDictationKeyDown: () => noopUnsubscribe,
    onActivateWorktree: () => noopUnsubscribe,
    onCreateTerminal: () => noopUnsubscribe,
    onRequestTerminalCreate: () => noopUnsubscribe,
    replyTerminalCreate: () => {},
    onSplitTerminal: () => noopUnsubscribe,
    onRenameTerminal: () => noopUnsubscribe,
    onFocusTerminal: () => noopUnsubscribe,
    onFocusEditorTab: () => noopUnsubscribe,
    onCloseSessionTab: () => noopUnsubscribe,
    onMoveSessionTab: () => noopUnsubscribe,
    onOpenFileFromMobile: () => noopUnsubscribe,
    onOpenDiffFromMobile: () => noopUnsubscribe,
    onMobileMarkdownRequest: () => noopUnsubscribe,
    respondMobileMarkdownRequest: () => {},
    onCloseTerminal: () => noopUnsubscribe,
    onSleepWorktree: () => noopUnsubscribe,
    // Why: paired web is a full renderer that wakes on activation; mobile wake is
    // desktop-host-scoped, so the web client never receives this signal.
    onResumeSleepingAgents: () => noopUnsubscribe,
    onTerminalZoom: () => noopUnsubscribe,
    // Why: a paired web client has no OS sleep signal; occlusion-driven
    // visibilitychange already covers its wake recovery.
    onSystemResumed: () => noopUnsubscribe,
    onFileDrop: () => noopUnsubscribe,
    syncTrafficLights: () => {},
    setMarkdownEditorFocused: () => {},
    setTerminalInputFocused: () => {},
    setFloatingTerminalInputFocused: () => {},
    setShortcutRecorderFocused: () => {},
    onRichMarkdownContextCommand: () => noopUnsubscribe,
    onFullscreenChanged: () => noopUnsubscribe,
    minimize: () => {},
    maximize: () => {},
    onMaximizeChanged: () => noopUnsubscribe,
    requestClose: () => {},
    popupMenu: () => {},
    onWindowCloseRequested: () => noopUnsubscribe,
    confirmWindowClose: () => {}
  }
}

function createPreflightApi(): NonNullable<Partial<PreloadApi>['preflight']> {
  const fallbackStatus: PreflightStatus = {
    git: { installed: false },
    gh: { installed: false, authenticated: false },
    glab: { installed: false, authenticated: false },
    bitbucket: { configured: false, authenticated: false, account: null },
    azureDevOps: {
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    },
    gitea: {
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    }
  }
  const fallbackRefreshAgents: RefreshAgentsResult = {
    agents: [],
    addedPathSegments: [],
    shellHydrationOk: false,
    pathSource: 'sync_seed_only',
    pathFailureReason: 'spawn_error'
  }
  type WindowsTerminalCapabilityBridgeResult = {
    wslAvailable: boolean
    wslDistros: string[]
    pwshAvailable: boolean
    gitBashAvailable: boolean
    hostPlatform: NodeJS.Platform | null
  }
  const fallbackWindowsTerminalCapabilities = {
    wslAvailable: false,
    wslDistros: [],
    pwshAvailable: false,
    gitBashAvailable: false,
    hostPlatform: null
  }
  return {
    check: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return fallbackStatus
      }
      return callRuntimeResult<PreflightStatus>('preflight.check', args)
    },
    detectAgents: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return []
      }
      return callRuntimeResult<string[]>('preflight.detectAgents').catch(() => [])
    },
    refreshAgents: () =>
      requireActiveEnvironmentOrNull()
        ? callRuntimeResult('preflight.refreshAgents')
            .then((result) => result as RefreshAgentsResult)
            .catch(() => fallbackRefreshAgents)
        : Promise.resolve(fallbackRefreshAgents),
    detectRemoteAgents: async (args) =>
      requireActiveEnvironmentOrNull()
        ? callRuntimeResult<string[]>('preflight.detectRemoteAgents', args).catch(() => [])
        : [],
    detectRemoteWindowsTerminalCapabilities: async (args) =>
      requireActiveEnvironmentOrNull()
        ? callRuntimeResult<WindowsTerminalCapabilityBridgeResult>(
            'preflight.detectRemoteWindowsTerminalCapabilities',
            args
          ).catch(() => fallbackWindowsTerminalCapabilities)
        : Promise.resolve(fallbackWindowsTerminalCapabilities)
  }
}

// unsupportedCliStatus is the honest answer for a caller that hasn't (yet)
// threaded a devServerId through — see relayOrStubCli below. It used to be
// createCliApi's ONLY answer, unconditionally, which is the literal error
// text ("CLI registration is managed on the Orca server, not in the web
// browser.") reported live on b15.openledger.vn's Settings > Orchestration
// Install button.
function unsupportedCliStatus(): CliInstallStatus {
  return {
    platform: getBrowserPlatform(),
    commandName: getBrowserPlatform() === 'linux' ? 'orca-ide' : 'orca',
    commandPath: null,
    pathDirectory: null,
    pathConfigured: false,
    launcherPath: null,
    installMethod: null,
    supported: false,
    state: 'unsupported',
    currentTarget: null,
    unsupportedReason: 'launch_mode_unavailable',
    detail: 'CLI registration is managed on the Orca server, not in the web browser.'
  }
}

// relayOrStubCli backs every cli.* method: with a devServerId, relay to that
// connected Dev Server's agent through backend-go's wscompat/channels_cli.go
// (RelayByDevServer -> agent/src/relay/agent-cli-handler.ts, real
// getInstallStatus/install/remove/getWslInstallStatus/installWsl/removeWsl —
// nothing about registering a CLI executes in the browser or in api-gateway
// itself, both are pure relay). Without one — every caller not yet updated
// to pass devServerId, see runtime-cli-client.ts's doc comment — this keeps
// the prior, honest "unsupported in the browser" stub unchanged.
function relayOrStubCli(
  method: string,
  devServerId: string | undefined,
  extraParams?: Record<string, unknown>
): Promise<CliInstallStatus> {
  if (!devServerId) {
    return Promise.resolve(unsupportedCliStatus())
  }
  return callRuntimeResult<CliInstallStatus>(method, { devServerId, ...extraParams })
}

function createCliApi(): NonNullable<Partial<PreloadApi>['cli']> {
  return {
    getInstallStatus: (args) => relayOrStubCli('cli.getInstallStatus', args?.devServerId),
    install: (args) => relayOrStubCli('cli.install', args?.devServerId),
    remove: (args) => relayOrStubCli('cli.remove', args?.devServerId),
    getWslInstallStatus: (args) =>
      relayOrStubCli('cli.getWslInstallStatus', args?.devServerId, {
        distro: args?.distro ?? null
      }),
    installWsl: (args) =>
      relayOrStubCli('cli.installWsl', args?.devServerId, { distro: args?.distro ?? null }),
    removeWsl: (args) =>
      relayOrStubCli('cli.removeWsl', args?.devServerId, { distro: args?.distro ?? null })
  }
}

function createAgentHooksApi(): NonNullable<Partial<PreloadApi>['agentHooks']> {
  const status = (
    agent:
      | 'claude'
      | 'openclaude'
      | 'codex'
      | 'gemini'
      | 'antigravity'
      | 'amp'
      | 'cursor'
      | 'droid'
      | 'command-code'
      | 'grok'
      | 'copilot'
      | 'hermes'
      | 'devin'
  ) =>
    Promise.resolve({
      agent,
      state: 'not_installed',
      configPath: '',
      managedHooksPresent: false,
      detail: 'Agent hook status is only available on the Orca server.'
    } as const)
  return {
    claudeStatus: () => status('claude'),
    openClaudeStatus: () => status('openclaude'),
    codexStatus: () => status('codex'),
    geminiStatus: () => status('gemini'),
    antigravityStatus: () => status('antigravity'),
    ampStatus: () => status('amp'),
    cursorStatus: () => status('cursor'),
    droidStatus: () => status('droid'),
    commandCodeStatus: () => status('command-code'),
    grokStatus: () => status('grok'),
    copilotStatus: () => status('copilot'),
    hermesStatus: () => status('hermes'),
    devinStatus: () => status('devin')
  }
}

function createDeveloperPermissionsApi(): NonNullable<Partial<PreloadApi>['developerPermissions']> {
  return {
    getStatus: () => Promise.resolve([]),
    request: ({ id }) =>
      Promise.resolve({ id, status: 'unsupported', openedSystemSettings: false } as const),
    openSettings: () => Promise.resolve()
  }
}

function createComputerUsePermissionsApi(): NonNullable<
  Partial<PreloadApi>['computerUsePermissions']
> {
  return {
    getStatus: () =>
      callRuntimeResult<ComputerUsePermissionStatusResult>(
        'computer.permissionsStatus',
        {},
        15_000
      ),
    openSetup: (args) =>
      callRuntimeResult<ComputerUsePermissionSetupResult>(
        'computer.permissions',
        args ?? {},
        15_000
      ).catch(() => ({
        platform: getBrowserPlatform(),
        helperAppPath: null,
        openedSettings: false,
        launchedHelper: false,
        nextStep: 'Computer-use permissions are managed on the Orca server.'
      })),
    reset: () =>
      Promise.resolve({
        platform: getBrowserPlatform(),
        helperAppPath: null,
        helperUnavailableReason: 'web_client',
        bundleId: null,
        permissions: []
      })
  }
}

function createSkillsApi(): NonNullable<Partial<PreloadApi>['skills']> {
  return {
    discover: (target) =>
      callRuntimeResult<SkillDiscoveryResult>('skills.discover', target, 15_000).catch(() => ({
        skills: [],
        sources: [],
        scannedAt: Date.now()
      }))
  }
}

function createNotificationsApi(): NonNullable<Partial<PreloadApi>['notifications']> {
  return {
    dispatch: () => Promise.resolve({ delivered: false, reason: 'not-supported' }),
    dismiss: () => Promise.resolve({ dismissed: 0 }),
    openSystemSettings: () => Promise.resolve(),
    getPermissionStatus: () =>
      Promise.resolve({ supported: false, platform: getBrowserPlatform(), requested: false }),
    probeDelivery: () => Promise.resolve({ state: 'unsupported' as const, authoritative: false }),
    playSound: () => Promise.resolve({ played: false, reason: 'missing-path' })
  }
}

function createRateLimitsApi(): NonNullable<Partial<PreloadApi>['rateLimits']> {
  const empty: RateLimitState = {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
  return {
    get: () => Promise.resolve(empty),
    refresh: () => Promise.resolve(empty),
    refreshCodexForTarget: () => Promise.resolve(empty),
    // Why: web clients do not own local Codex auth, so reset-credit
    // redemption remains desktop-only and reports the safe no-credit outcome.
    consumeCodexResetCredit: () => Promise.resolve({ outcome: 'noCredit', state: empty }),
    refreshClaudeForTarget: () => Promise.resolve(empty),
    setPollingInterval: () => Promise.resolve(),
    fetchInactiveClaudeAccounts: () => Promise.resolve(),
    fetchInactiveCodexAccounts: () => Promise.resolve(),
    refreshMiniMax: () => Promise.resolve(empty),
    refreshGrok: () => Promise.resolve(empty),
    onUpdate: () => noopUnsubscribe
  }
}

function createMiniMaxCredentialsApi(): NonNullable<Partial<PreloadApi>['minimaxCredentials']> {
  const notConfigured = { configured: false }
  const unsupportedError = new Error('MiniMax cookie storage is only available in the desktop app.')
  return {
    getStatus: () => Promise.resolve(notConfigured),
    saveCookie: () => Promise.reject(unsupportedError),
    clearCookie: () => Promise.resolve(notConfigured)
  }
}

function createGrokAccountsApi(): NonNullable<Partial<PreloadApi>['grokAccounts']> {
  const unsigned = {
    signedIn: false,
    email: null,
    teamId: null,
    tokenFresh: false,
    error: null
  }
  return {
    getStatus: () => Promise.resolve(unsigned)
  }
}

function createAccountsApi(): never {
  const empty = {
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  }
  return {
    list: () => Promise.resolve(empty),
    add: () => Promise.resolve(empty),
    cancelPendingLogin: () => Promise.resolve(false),
    reauthenticate: () => Promise.resolve(empty),
    remove: () => Promise.resolve(empty),
    select: () => Promise.resolve(empty)
  } as never
}

function createUpdaterApi(): NonNullable<Partial<PreloadApi>['updater']> {
  return {
    getVersion: () => Promise.resolve('web'),
    getStatus: () => Promise.resolve({ state: 'idle' } as never),
    check: () => Promise.resolve(),
    download: () => Promise.resolve(),
    quitAndInstall: () => Promise.resolve(),
    dismissNudge: () => Promise.resolve(),
    onStatus: () => noopUnsubscribe,
    onClearDismissal: () => noopUnsubscribe
  }
}

function createShellApi(): NonNullable<Partial<PreloadApi>['shell']> {
  const openResult = { ok: true } as const
  return {
    openPath: (path) =>
      Promise.resolve(window.open(path, '_blank', 'noopener,noreferrer') as never),
    openInFileManager: () => Promise.resolve(openResult),
    openInExternalEditor: () => Promise.resolve(openResult),
    openUrl: (url) => Promise.resolve(window.open(url, '_blank', 'noopener,noreferrer') as never),
    openFilePath: () => Promise.resolve(false),
    openFileUri: (uri) =>
      Promise.resolve(window.open(uri, '_blank', 'noopener,noreferrer') as never),
    pathExists: async (path) => {
      try {
        await resolveRuntimeFilePath(path)
        return true
      } catch {
        return false
      }
    },
    pickAttachment: () => Promise.resolve(null),
    pickImage: () => Promise.resolve(null),
    pickRepoIconImage: () => Promise.resolve(null),
    pickAudio: () => Promise.resolve(null),
    pickDirectory: () => Promise.resolve(null),
    copyFile: () => Promise.resolve()
  }
}

function createPtyApi(): NonNullable<Partial<PreloadApi>['pty']> {
  return {
    spawn: () => Promise.reject(new Error('Local PTYs are unavailable in the web client.')),
    write: () => {},
    writeAccepted: () => Promise.resolve(false),
    resize: () => {},
    claimViewport: () => {},
    reportGeometry: () => {},
    signal: () => {},
    // Web panes clear the host buffer via the terminal.clearBuffer runtime RPC.
    clearBuffer: () => {},
    kill: () => Promise.resolve(),
    ackColdRestore: () => {},
    ackData: () => {},
    onDeliveryResyncRequest: () => noopUnsubscribe,
    respondDeliveryResync: () => {},
    // Why healthy stub: web terminals ride the remote-runtime transport, not
    // main's delivery gate — a zero-in-flight reply keeps the watchdog idle.
    reportRendererDeliveryState: () =>
      Promise.resolve({ inFlightTotalChars: 0, inFlightPtyCount: 0, msSinceLastAck: null }),
    getPtyDataListenerCount: () => 0,
    rendererDispatcherReady: () => {},
    setActiveRendererPty: () => {},
    setRendererPtyVisible: () => {},
    setHiddenRendererPty: () => {},
    setPtyDeliveryInterest: () => {},
    // Why no-op: remote-runtime PTYs are never hidden-gate markable, so the
    // web client has no main-side responder to feed.
    publishTerminalViewAttributes: () => {},
    hasChildProcesses: () => Promise.resolve(false),
    getForegroundProcess: () => Promise.resolve(null),
    // Why: paired web panes cannot provide a local post-boundary process scan.
    confirmForegroundProcess: () => Promise.resolve(null),
    getCwd: () => Promise.resolve('~'),
    getSize: () => Promise.resolve(null),
    listSessions: () => Promise.resolve([]),
    hasPty: () => Promise.resolve(null),
    getMainBufferSnapshot: () => Promise.resolve(null),
    // Why: remote-runtime PTYs never transit local main, so the web client has
    // no side-effect facts source; renderer byte parsing stays authoritative.
    onSideEffect: () => noopUnsubscribe,
    getSideEffectSnapshot: () => Promise.resolve(null),
    getRendererDeliveryDebugSnapshot: () =>
      Promise.resolve({
        pendingPtyCount: 0,
        pendingChars: 0,
        maxPendingCharsByPty: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        maxRendererInFlightCharsByPty: 0,
        activeRendererPtyCount: 0,
        flushScheduled: false,
        peakPendingChars: 0,
        peakMaxPendingCharsByPty: 0,
        peakRendererInFlightChars: 0,
        peakMaxRendererInFlightCharsByPty: 0,
        ackGatedFlushSkipCount: 0,
        hiddenDeliveryGatedPtyCount: 0,
        hiddenDeliveryGatedVisiblePtyCount: 0,
        hiddenDeliveryGatedActivePtyCount: 0,
        deliveryInterestPtyCount: 0,
        hiddenDeliveryDroppedChars: 0,
        hiddenDeliveryDroppedChunks: 0,
        pendingDroppedChars: 0,
        diagnostics: EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS,
        rendererLifecycleResetCount: 0,
        lastLifecycleResetClearedChars: 0,
        rendererPtyDispatcherReady: false,
        rendererDispatcherReadyForcedCount: 0
      }),
    resetRendererDeliveryDebug: () => Promise.resolve(),
    onData: () => noopUnsubscribe,
    onReplay: () => noopUnsubscribe,
    onModelRestoreNeeded: () => noopUnsubscribe,
    onExit: () => noopUnsubscribe,
    onSerializeBufferRequest: () => noopUnsubscribe,
    onClearBufferRequest: () => noopUnsubscribe,
    sendSerializedBuffer: () => {},
    declarePendingPaneSerializer: () => Promise.resolve(0),
    settlePaneSerializer: () => Promise.resolve(),
    clearPendingPaneSerializer: () => Promise.resolve(),
    management: {
      listSessions: () => Promise.resolve({ sessions: [], degraded: false }),
      killAll: () => Promise.resolve({ killedCount: 0, remainingCount: 0 }),
      killOne: () => Promise.resolve({ success: false }),
      restart: () => Promise.resolve({ success: false })
    }
  }
}

function createSshApi(): NonNullable<Partial<PreloadApi>['ssh']> {
  return {
    // Why: SSH connections are owned by the paired host. Read/connect route to
    // its runtime RPC so remote worktrees can show real connection state and
    // reconnect (STA-1468); target management stays desktop-only.
    listTargets: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return []
      }
      const { targets } = await callRuntimeResult<{ targets: SshTarget[] }>('ssh.listTargets')
      return targets
    },
    listRemovedTargetLabels: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return {}
      }
      const { labels } = await callRuntimeResult<{ labels: Record<string, string> }>(
        'ssh.listRemovedTargetLabels'
      )
      return labels
    },
    addTarget: () =>
      Promise.reject(new Error('SSH target management is unavailable in the web client.')),
    updateTarget: () =>
      Promise.reject(new Error('SSH target management is unavailable in the web client.')),
    removeTarget: () => Promise.resolve(),
    importConfig: () => Promise.resolve({ targets: [], repoReadoptions: [] }),
    connect: async (args) => {
      const { state } = await callRuntimeResult<{ state: SshConnectionState | null }>(
        'ssh.connect',
        { targetId: args.targetId }
      )
      return state
    },
    disconnect: () => Promise.resolve(),
    terminateSessions: () => Promise.resolve(),
    resetRelay: () => Promise.resolve(),
    getState: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      const { state } = await callRuntimeResult<{ state: SshConnectionState | null }>(
        'ssh.getState',
        { targetId: args.targetId }
      )
      return state
    },
    needsPassphrasePrompt: () => Promise.resolve(false),
    testConnection: () =>
      Promise.resolve({
        success: false,
        error: translate('auto.web.web.preload.api.31bfe8ae1a', 'Unavailable in the web client.')
      }),
    onStateChanged: () => noopUnsubscribe,
    addPortForward: () =>
      Promise.reject(new Error('SSH port forwarding is unavailable in the web client.')),
    updatePortForward: () =>
      Promise.reject(new Error('SSH port forwarding is unavailable in the web client.')),
    removePortForward: () => Promise.resolve(null),
    listPortForwards: () => Promise.resolve([]),
    listDetectedPorts: () => Promise.resolve([]),
    onPortForwardsChanged: () => noopUnsubscribe,
    onDetectedPortsChanged: () => noopUnsubscribe,
    browseDir: () => Promise.resolve({ entries: [], resolvedPath: '' }),
    onCredentialRequest: () => noopUnsubscribe,
    onCredentialResolved: () => noopUnsubscribe,
    submitCredential: () => Promise.resolve(),
    // [CR-001] Fleet import — desktop-only feature; web client returns safe no-ops.
    pickFleetConfigFile: () => Promise.resolve(null),
    importFleetConfig: () =>
      Promise.resolve({ imported: 0, skipped: 0, failed: 0, errors: [], targets: [] }),
    onFleetImportProgress: () => noopUnsubscribe,
    // [CR-003] Bulk provisioning — desktop-only; no-ops on web client.
    provisionFleetServers: () => Promise.resolve(),
    cancelProvisioning: () => Promise.resolve(),
    onProvisioningProgress: () => noopUnsubscribe,
    // [CR-005] Fleet health — desktop-only; no-ops on web client.
    getFleetHealth: () => Promise.resolve({ servers: [] }),
    refreshFleetHealth: () => Promise.resolve(),
    // [CR-004] Dev bootstrap — desktop-only; no-ops on web client.
    bootstrapServer: () => Promise.resolve(),
    cancelBootstrap: () => Promise.resolve(),
    onBootstrapProgress: () => noopUnsubscribe
  }
}

async function callRuntimeEnvelope<TResult = unknown>(
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<RuntimeRpcResponse<TResult>> {
  const environment = requireActiveEnvironment()
  const response = await runtimeCallQueuePool.enqueue(environment.id, method, () =>
    getClientForEnvironment(environment).call(method, params, { timeoutMs })
  )
  updateEnvironmentFromResponse(environment, response)
  return response as RuntimeRpcResponse<TResult>
}

async function callEnvironmentEnvelope<TResult = unknown>(
  selector: string,
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<RuntimeRpcResponse<TResult>> {
  const environment = resolveEnvironment(selector)
  const response = await runtimeCallQueuePool.enqueue(environment.id, method, () =>
    getClientForEnvironment(environment).call(method, params, { timeoutMs })
  )
  updateEnvironmentFromResponse(environment, response)
  return response as RuntimeRpcResponse<TResult>
}

async function callRuntimeResult<TResult>(
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<TResult> {
  const response = await callRuntimeEnvelope(method, params, timeoutMs)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as TResult
}

async function saveClipboardImageAsTempFileInRuntime(
  contentBase64: string,
  args?: { connectionId?: string | null; runtimeEnvironmentId?: string | null }
): Promise<string> {
  if (contentBase64.length > MAX_CLIPBOARD_IMAGE_BASE64_CHARS) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  }
  const connectionId = args?.connectionId ?? null
  const startResponse = await callRuntimeEnvelope<{ uploadId: string }>(
    'clipboard.startImageUpload',
    { expectedBase64Length: contentBase64.length, connectionId },
    CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
  )
  if (!startResponse.ok) {
    if (
      startResponse.error.code === 'method_not_found' &&
      contentBase64.length <= CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS
    ) {
      return callRuntimeResult<string>(
        'clipboard.saveImageAsTempFile',
        { contentBase64, connectionId },
        CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
      )
    }
    throw new Error(startResponse.error.message)
  }

  const { uploadId } = startResponse.result
  try {
    for (
      let offset = 0;
      offset < contentBase64.length;
      offset += CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
    ) {
      await callRuntimeResult(
        'clipboard.appendImageUploadChunk',
        {
          uploadId,
          offset,
          contentBase64: contentBase64.slice(
            offset,
            offset + CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
          )
        },
        CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
      )
    }
    return await callRuntimeResult<string>(
      'clipboard.commitImageUpload',
      { uploadId },
      CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
    )
  } catch (error) {
    // Why: once chunked paste has created server-side state, failed append or
    // commit must not wait for TTL cleanup before releasing the bounded slot.
    await callRuntimeResult(
      'clipboard.abortImageUpload',
      { uploadId },
      CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
    ).catch(() => {})
    throw error
  }
}

async function getRemoteRuntimeStatus(): Promise<RuntimeStatus> {
  return callRuntimeResult<RuntimeStatus>('status.get', undefined, 15_000)
}

function getClientForEnvironment(
  environment: StoredWebRuntimeEnvironment
): WebRuntimeClient | WebSessionClient {
  if (!activeClient || activeClientEnvironmentId !== environment.id) {
    activeClient?.close()

    const preferredEndpoint =
      environment.endpoints.find((ep) => ep.id === environment.preferredEndpointId) ??
      environment.endpoints[0]

    // Why: session-auth environment has empty E2EE keys — WsSessionRouter validates
    // the session cookie server-side. Use WebSessionClient (plain WS over cookie)
    // instead of WebRuntimeClient which requires Curve25519 key exchange.
    // See TASK-PC-004 in specs/backend/bugs/paircode-v1/.
    // Otherwise (pair code / E2EE environment): full key exchange via WebRuntimeClient.
    activeClient =
      preferredEndpoint && (!preferredEndpoint.deviceToken || !preferredEndpoint.publicKeyB64)
        ? new WebSessionClient(preferredEndpoint.endpoint)
        : new WebRuntimeClient(getPreferredWebPairingOffer(environment))

    activeClientEnvironmentId = environment.id
  }
  return activeClient
}

function closeActiveRuntimeClients(): void {
  activeClient?.close()
  activeClient = null
  activeClientEnvironmentId = null
  invalidateRuntimeWorktreeCaches()
}

function disconnectActiveRuntimeEnvironment(): void {
  closeActiveRuntimeClients()
  clearStoredWebRuntimeEnvironment()
  activeEnvironment = null
}

function resolveEnvironment(selector: string): StoredWebRuntimeEnvironment {
  const environment = requireActiveEnvironment()
  if (selector === environment.id || selector === environment.name || selector === 'active') {
    return environment
  }
  if (selector.startsWith('web-') && environment.id.startsWith('web-')) {
    // Why: persisted terminal ids can outlive a web-client re-pair, which creates
    // a fresh web-* environment id even when it points at the same active server.
    return environment
  }
  if (selector === 'session-auth' && environment.id === 'session-auth') {
    // Why: session-authenticated environments use the stable id 'session-auth'
    // (created by createSessionWebRuntimeEnvironment). Route to the active
    // environment without requiring an exact name/id match.
    return environment
  }
  throw new Error(`Unknown Orca runtime environment: ${selector}`)
}

function requireActiveEnvironment(): StoredWebRuntimeEnvironment {
  activeEnvironment = activeEnvironment ?? readStoredWebRuntimeEnvironment()
  if (!activeEnvironment) {
    throw new Error('Pair this web client with an Orca server first.')
  }
  return activeEnvironment
}

function requireActiveEnvironmentOrNull(): StoredWebRuntimeEnvironment | null {
  activeEnvironment = activeEnvironment ?? readStoredWebRuntimeEnvironment()
  return activeEnvironment
}

function updateEnvironmentFromResponse(
  environment: StoredWebRuntimeEnvironment,
  response: RuntimeRpcResponse<unknown>
): void {
  const runtimeId = response.ok ? response._meta.runtimeId : (response._meta?.runtimeId ?? null)
  activeEnvironment = updateStoredEnvironmentRuntimeId(environment, runtimeId)
}

function getStoredSettings(): GlobalSettings {
  const environment = (activeEnvironment = activeEnvironment ?? readStoredWebRuntimeEnvironment())
  const defaults = getDefaultSettings('~')
  const rawStoredSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
  const stored = readJson<Partial<GlobalSettings>>(SETTINGS_STORAGE_KEY, {})
  const migratedStored = {
    ...stored,
    ...normalizeAutoRenameBranchFromWorkDefaultOn(stored),
    ...normalizeTerminalCursorStyleDefault(stored),
    terminalCustomThemes: normalizeTerminalCustomThemes(stored.terminalCustomThemes),
    uiLanguage: normalizeUiLanguage(stored.uiLanguage)
  }
  if (
    rawStoredSettings &&
    (stored.autoRenameBranchFromWork !== migratedStored.autoRenameBranchFromWork ||
      stored.autoRenameBranchFromWorkDefaultedOn !==
        migratedStored.autoRenameBranchFromWorkDefaultedOn ||
      stored.terminalCursorStyle !== migratedStored.terminalCursorStyle ||
      stored.terminalCursorStyleDefaultedToBlock !==
        migratedStored.terminalCursorStyleDefaultedToBlock ||
      stored.terminalCustomThemes !== migratedStored.terminalCustomThemes ||
      stored.uiLanguage !== migratedStored.uiLanguage)
  ) {
    try {
      const parsed = JSON.parse(rawStoredSettings) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        writeJson(SETTINGS_STORAGE_KEY, migratedStored)
      }
    } catch {
      // Keep readJson's invalid-JSON fallback non-destructive.
    }
  }
  return mergeSettings(
    {
      ...defaults,
      floatingTerminalEnabled: false,
      rightSidebarOpenByDefault: false,
      activeRuntimeEnvironmentId: environment?.id ?? null
    },
    migratedStored
  )
}

async function getRuntimeBackedStoredSettings(): Promise<GlobalSettings> {
  const local = getStoredSettings()
  if (!requireActiveEnvironmentOrNull()) {
    return local
  }
  try {
    const result = await callRuntimeResult<{ settings: Partial<GlobalSettings> }>(
      'settings.get',
      undefined,
      15_000
    )
    const runtimeSettings: Partial<GlobalSettings> = {}
    if (typeof result.settings.experimentalNewWorktreeCardStyle === 'boolean') {
      runtimeSettings.experimentalNewWorktreeCardStyle =
        result.settings.experimentalNewWorktreeCardStyle
    }
    if (typeof result.settings.compactWorktreeCards === 'boolean') {
      runtimeSettings.compactWorktreeCards = result.settings.compactWorktreeCards
    }
    if (typeof result.settings.minimaxGroupId === 'string') {
      runtimeSettings.minimaxGroupId = result.settings.minimaxGroupId
    }
    if (typeof result.settings.minimaxUsageModels === 'string') {
      runtimeSettings.minimaxUsageModels = result.settings.minimaxUsageModels
    }
    if (Array.isArray(result.settings.prBotAuthorOverrides)) {
      runtimeSettings.prBotAuthorOverrides = normalizePRBotAuthorOverrides(
        result.settings.prBotAuthorOverrides
      )
    }
    const next = mergeSettings(local, runtimeSettings)
    writeJson(SETTINGS_STORAGE_KEY, next)
    return next
  } catch {
    // Why: unpaired/offline web clients keep a local settings fallback.
    return local
  }
}

async function syncRuntimeBackedSettings(
  updates: Partial<GlobalSettings>,
  localNext: GlobalSettings
): Promise<GlobalSettings> {
  if (!requireActiveEnvironmentOrNull()) {
    return localNext
  }
  const runtimeUpdates: Partial<GlobalSettings> = {}
  if (typeof updates.experimentalNewWorktreeCardStyle === 'boolean') {
    runtimeUpdates.experimentalNewWorktreeCardStyle = updates.experimentalNewWorktreeCardStyle
  }
  if (typeof updates.compactWorktreeCards === 'boolean') {
    runtimeUpdates.compactWorktreeCards = updates.compactWorktreeCards
  }
  if (typeof updates.minimaxGroupId === 'string') {
    runtimeUpdates.minimaxGroupId = updates.minimaxGroupId
  }
  if (typeof updates.minimaxUsageModels === 'string') {
    runtimeUpdates.minimaxUsageModels = updates.minimaxUsageModels
  }
  if (Array.isArray(updates.prBotAuthorOverrides)) {
    runtimeUpdates.prBotAuthorOverrides = normalizePRBotAuthorOverrides(
      updates.prBotAuthorOverrides
    )
  }
  if (Object.keys(runtimeUpdates).length === 0) {
    return localNext
  }
  try {
    const result = await callRuntimeResult<{ settings: Partial<GlobalSettings> }>(
      'settings.update',
      runtimeUpdates,
      15_000
    )
    const next = mergeSettings(localNext, result.settings)
    writeJson(SETTINGS_STORAGE_KEY, next)
    return next
  } catch {
    // Why: unpaired/offline web clients still need local settings persistence.
    return localNext
  }
}

// ── FE-TASK-STORAGE-006: full GlobalSettings sync via clientState.*
// (backend-go), parallel to the 5-field legacy path above ─────────────────
//
// ⚠️ Security-review gate (see FE-TASK-STORAGE-006 task doc / CR-STORAGE-003):
// a formal security review of vapidKeys/webPushSubscriptions/
// codexManagedAccounts/claudeManagedAccounts has NOT happened — no human
// reviewer signed off in this session. stripSecretFields() below is a
// DEFENSIVE MITIGATION applied unconditionally before every outbound sync,
// not a substitute for that review. It was written by reading the field
// definitions directly (frontend/src/shared/types.ts) and redacting anything
// that is, or plausibly contains, raw secret/credential/push-endpoint
// material:
//   - vapidKeys: the VAPID keypair's privateKey signs every Web Push message
//     this server sends — a server-wide signing secret, not per-client
//     preference data, and never safe to mirror into a shared multi-tenant
//     JSON blob.
//   - webPushSubscriptions: each entry carries `endpoint` (a bearer-like URL:
//     anyone holding it can push-send to that browser) and `keys.auth`/
//     `keys.p256dh` (the subscription's encryption secrets) — device
//     credentials, not settings.
//   - codexManagedAccounts / claudeManagedAccounts: `managedHomePath`/
//     `managedAuthPath` (+ their wsl* variants) point at THIS machine's
//     on-disk managed-account auth material and can leak local
//     usernames/paths; they are not portable across devices and have no
//     legitimate reason to leave this machine via a synced settings blob.
// Still needed: an actual security review sign-off confirming this list is
// complete and that redacting (vs. omitting the sync entirely) is the right
// call for each field — flagged explicitly in this task's status update, do
// not treat this comment as closing that requirement.
function stripSecretFields(settings: GlobalSettings): GlobalSettings {
  return {
    ...settings,
    vapidKeys: null,
    webPushSubscriptions: [],
    codexManagedAccounts: [],
    claudeManagedAccounts: []
  }
}

async function getFullClientSettings(): Promise<GlobalSettings | null> {
  if (!requireActiveEnvironmentOrNull()) {
    return null
  }
  try {
    const result = await callRuntimeResult<{ found: boolean; stateJson?: string }>(
      'clientState.get',
      { kind: 'settings' },
      15_000
    )
    return result.found && result.stateJson
      ? (JSON.parse(result.stateJson) as GlobalSettings)
      : null
  } catch {
    // Why: unpaired/offline/pre-rollout backend-go keeps this a soft miss —
    // callers fall back to the legacy 5-field/local path, same as every
    // other RPC helper in this file.
    return null
  }
}

async function syncFullClientSettings(next: GlobalSettings): Promise<void> {
  if (!requireActiveEnvironmentOrNull()) {
    return
  }
  const safe = stripSecretFields(next)
  await callRuntimeResult(
    'clientState.set',
    { kind: 'settings', stateJson: JSON.stringify(safe) },
    15_000
  )
}

// FE-TASK-STORAGE-007: seed backend-go's full-settings record exactly once
// from today's local settings, so an existing user's preferences survive the
// CR-STORAGE-003 rollout instead of resetting to defaults on first read.
// Re-checks getFullClientSettings() itself (rather than trusting a caller's
// already-null result) so it is safe to call from multiple call sites/re-
// mounts without double-seeding.
async function ensureFullSettingsSeeded(): Promise<GlobalSettings> {
  const remote = await getFullClientSettings()
  if (remote !== null) {
    return remote
  }
  const local = getStoredSettings()
  try {
    await syncFullClientSettings(local)
  } catch (error) {
    // Why: this runs fire-and-forget from settings.get() — an unhandled
    // rejection here must not surface as an unrelated crash. A failed seed
    // just means the next settings.get() call retries it (getFullClientSettings
    // will still see no remote record).
    console.error('Failed to seed full client settings to backend-go:', error)
  }
  return local
}

async function updateRuntimePRBotAuthorOverride(args: {
  author: string
  isBot: boolean
}): Promise<GlobalSettings> {
  const local = getStoredSettings()
  if (requireActiveEnvironmentOrNull()) {
    // Why: a paired client must not report a successful mark that the
    // authoritative runtime failed to persist and will later overwrite.
    const result = await callRuntimeResult<{ settings: Partial<GlobalSettings> }>(
      'settings.updatePRBotAuthorOverride',
      args,
      15_000
    )
    const next = mergeSettings(local, {
      prBotAuthorOverrides: normalizePRBotAuthorOverrides(result.settings.prBotAuthorOverrides)
    })
    writeJson(SETTINGS_STORAGE_KEY, next)
    return next
  }
  const next = mergeSettings(local, {
    prBotAuthorOverrides: applyPRBotAuthorOverride(
      local.prBotAuthorOverrides,
      args.author,
      args.isBot
    )
  })
  writeJson(SETTINGS_STORAGE_KEY, next)
  return next
}

function getStoredOnboarding(): OnboardingState {
  const storedRaw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY)
  if (storedRaw) {
    const stored = readJson(ONBOARDING_STORAGE_KEY, getDefaultOnboardingState())
    if (stored.checklist.dismissed) {
      return stored
    }
    const closed = closeWebOnboarding(stored)
    writeJson(ONBOARDING_STORAGE_KEY, closed)
    return closed
  }
  const closed = closeWebOnboarding(getDefaultOnboardingState())
  // Why: pairing already means the user has an Orca server. Desktop first-run
  // onboarding would incorrectly probe browser-local tools and block the client.
  writeJson(ONBOARDING_STORAGE_KEY, closed)
  return closed
}

/** Resolve the localStorage key for a session partition. Non-'local' hosts get
 *  a host-suffixed key so their sessions never clobber the local one. */
function sessionStorageKeyForHost(hostId?: string | null): string {
  const resolved = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  return resolved === LOCAL_EXECUTION_HOST_ID
    ? SESSION_STORAGE_KEY
    : `${SESSION_STORAGE_KEY}.${resolved}`
}

function getStoredWorkspaceSession(hostId?: string | null): WorkspaceSessionState {
  const resolvedHostId = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  const storageKey = sessionStorageKeyForHost(resolvedHostId)
  // FE-TASK-STORAGE-008: localStorage never written for this partition (new
  // browser/profile, or cleared site data) — return the default immediately
  // (no blocking on a network round trip) and kick off a background hydrate
  // from backend-go to repopulate localStorage for the NEXT read. An existing
  // record — even one that happens to equal the default shape — takes the
  // unchanged paths below instead of re-triggering this every call.
  if (window.localStorage.getItem(storageKey) === null) {
    void hydrateWorkspaceSessionFromRemote(hostId ?? undefined)
    return getDefaultWorkspaceSession()
  }
  if (resolvedHostId !== LOCAL_EXECUTION_HOST_ID) {
    return sanitizeWebRuntimeWorkspaceSession(readJson(storageKey, getDefaultWorkspaceSession()))
  }
  const localSession = sanitizeWebRuntimeWorkspaceSession(
    readJson(SESSION_STORAGE_KEY, getDefaultWorkspaceSession())
  )
  if (!requireActiveEnvironmentOrNull()) {
    return localSession
  }
  const ui = readLocalWebUIState()
  // Why: paired web clients mirror host session-tabs after startup. Replaying
  // browser-local terminal handles first creates stale remote PTYs and errors.
  return sanitizeWebRuntimeWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    activeRepoId: ui.lastActiveRepoId,
    activeWorktreeId: ui.lastActiveWorktreeId,
    lastVisitedAtByWorktreeId: localSession.lastVisitedAtByWorktreeId
  })
}

// FE-TASK-STORAGE-008: debounced remote mirror of session.set/patch. 1s
// trailing / 5s max-wait matches desktop's orca-data.json writer cadence
// (see ui-settings-session-hybrid.md's session section) — session.patch fires
// on every tab/layout change, so this collapses a burst into one RPC instead
// of flooding backend-go.
const flushWorkspaceSessionRemote = debounce(
  async (hostId?: string) => {
    if (!requireActiveEnvironmentOrNull()) {
      return
    }
    try {
      const session = getStoredWorkspaceSession(hostId)
      await callRuntimeResult(
        'workspaceSession.set',
        { hostId: hostId ?? 'local', sessionJson: JSON.stringify(session) },
        15_000
      )
    } catch {
      // Why: best-effort background sync — localStorage already has the
      // correct value for this device; a failed remote mirror just means a
      // fresh-install/cleared-cache restore on another device would miss it
      // until the next successful flush.
    }
  },
  { wait: 1_000, maxWait: 5_000 }
)

// Decision (FE-TASK-STORAGE-008 "Rủi ro cần xác nhận" — how to notify the
// store after a background hydrate completes): no existing PreloadApi
// channel exists for this (unlike remoteWorkspace.onChanged) and adding one
// would mean extending preload/api-types.ts's `session` shape, which is
// outside this task's file scope. Chosen instead: dispatch a plain
// `CustomEvent('orca:workspaceSessionHydrated', { detail: { hostId } })` on
// `window` — zero new IPC surface, no store coupling from this file. This is
// a hook, not a wired-up fix: nothing currently listens for it, so a hydrate
// that lands after the UI already read the default session will not repaint
// until the next natural session.get() call. Flagged as follow-up, not
// silently "solved".
function notifyWorkspaceSessionHydrated(hostId?: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent('orca:workspaceSessionHydrated', { detail: { hostId: hostId ?? null } })
    )
  } catch {
    // Why: a test/runtime environment without CustomEvent support must not
    // crash a background hydrate over a notification nicety.
  }
}

async function hydrateWorkspaceSessionFromRemote(hostId?: string): Promise<void> {
  if (!requireActiveEnvironmentOrNull()) {
    return
  }
  try {
    const resp = await callRuntimeResult<{ found: boolean; sessionJson?: string }>(
      'workspaceSession.get',
      { hostId: hostId ?? 'local' },
      15_000
    )
    if (resp.found && resp.sessionJson) {
      writeJson(sessionStorageKeyForHost(hostId), JSON.parse(resp.sessionJson))
      notifyWorkspaceSessionHydrated(hostId)
    }
  } catch {
    // Why: best-effort background hydrate — the caller already returned the
    // default session synchronously; a failure here just means the device
    // keeps using defaults until the next getStoredWorkspaceSession() call
    // (localStorage is still empty, so it retries).
  }
}

function closeWebOnboarding(base: OnboardingState): OnboardingState {
  return {
    ...base,
    flowVersion: ONBOARDING_FLOW_VERSION,
    closedAt: Date.now(),
    outcome: 'dismissed',
    checklist: {
      ...base.checklist,
      dismissed: true
    }
  }
}

function readLocalWebUIState(): PersistedUIState {
  const defaults = getDefaultUIState()
  const stored = readJson<Partial<PersistedUIState>>(UI_STORAGE_KEY, {})
  const storedSettings = getStoredSettings()
  const base = {
    ...defaults,
    // Why: when runtime ui.get is unavailable, web fallback must mirror the
    // main-process missing-property seed from the legacy card layout mode.
    worktreeCardProperties: getWorktreeCardModeProperties(
      storedSettings.compactWorktreeCards ? 'Compact' : 'Default'
    )
  }
  if (typeof stored.rightSidebarOpen === 'boolean') {
    return mergeWebUIState(base, stored)
  }
  return mergeWebUIState(base, {
    ...stored,
    // Why: web fallback lacks main-process normalization, so migrate the
    // retired setting only when the local UI preference is still absent.
    rightSidebarOpen: storedSettings.rightSidebarOpenByDefault
  })
}

function mergeWebUIState(
  base: PersistedUIState,
  updates: Partial<PersistedUIState>
): PersistedUIState {
  const { featureInteractionTelemetryBuckets: _reserved, ...safeUpdates } =
    updates as Partial<PersistedUIState> & {
      featureInteractionTelemetryBuckets?: unknown
    }
  void _reserved
  return {
    ...base,
    ...safeUpdates,
    worktreeCardProperties: normalizeWorktreeCardProperties(
      safeUpdates.worktreeCardProperties ?? base.worktreeCardProperties
    ),
    _worktreeCardModeDefaulted:
      safeUpdates._worktreeCardModeDefaulted ?? base._worktreeCardModeDefaulted,
    agentActivityDisplayMode: normalizeAgentActivityDisplayMode(
      safeUpdates.agentActivityDisplayMode ?? base.agentActivityDisplayMode
    ),
    usagePercentageDisplay: normalizeUsagePercentageDisplay(
      safeUpdates.usagePercentageDisplay ?? base.usagePercentageDisplay
    )
  }
}

function mergeFeatureInteractionState(
  current: PersistedUIState['featureInteractions'],
  incoming: PersistedUIState['featureInteractions']
): FeatureInteractionState {
  const currentNormalized = normalizeFeatureInteractions(current)
  const incomingNormalized = normalizeFeatureInteractions(incoming)
  const merged: FeatureInteractionState = { ...currentNormalized }
  for (const [id, incomingRecord] of Object.entries(incomingNormalized)) {
    const featureId = id as FeatureInteractionId
    const currentRecord = currentNormalized[featureId]
    merged[featureId] = currentRecord
      ? {
          firstInteractedAt: Math.min(
            currentRecord.firstInteractedAt,
            incomingRecord.firstInteractedAt
          ),
          interactionCount: Math.max(
            currentRecord.interactionCount,
            incomingRecord.interactionCount
          )
        }
      : incomingRecord
  }
  return merged
}

function mergeContextualTourSeenIds(
  current: PersistedUIState['contextualToursSeenIds'],
  incoming: PersistedUIState['contextualToursSeenIds']
): ContextualTourId[] {
  const merged = new Set<ContextualTourId>(normalizeContextualTourIds(current))
  for (const id of normalizeContextualTourIds(incoming)) {
    merged.add(id)
  }
  return [...merged]
}

function mergeSettings(
  base: GlobalSettings,
  updates: Partial<GlobalSettings>,
  options: { preserveAutoRenameBranchFromWorkUpdate?: boolean } = {}
): GlobalSettings {
  const defaults = getDefaultSettings('~')
  const merged = {
    ...base,
    ...updates,
    notifications: {
      ...base.notifications,
      ...updates.notifications
    },
    githubProjects: {
      ...(base.githubProjects ?? defaults.githubProjects),
      ...updates.githubProjects
    } as GlobalSettings['githubProjects'],
    disabledTuiAgents: normalizeDisabledTuiAgents(
      updates.disabledTuiAgents ?? base.disabledTuiAgents
    ),
    agentDefaultArgs: normalizeTuiAgentArgsRecord(
      updates.agentDefaultArgs ?? base.agentDefaultArgs
    ),
    agentDefaultEnv: normalizeTuiAgentEnvRecord(updates.agentDefaultEnv ?? base.agentDefaultEnv),
    voice: {
      ...(base.voice ?? defaults.voice),
      ...updates.voice
    } as NonNullable<GlobalSettings['voice']>,
    activeRuntimeEnvironmentId: activeEnvironment?.id ?? updates.activeRuntimeEnvironmentId ?? null,
    terminalCustomThemes: normalizeTerminalCustomThemes(
      updates.terminalCustomThemes ?? base.terminalCustomThemes
    ),
    uiLanguage: normalizeUiLanguage(updates.uiLanguage ?? base.uiLanguage)
  }
  return {
    ...merged,
    ...normalizeAutoRenameBranchFromWorkDefaultOn(merged, {
      preserveExplicitValue: options.preserveAutoRenameBranchFromWorkUpdate
    })
  }
}

async function listAllRuntimeWorktrees(): Promise<Worktree[]> {
  if (cachedWorktrees && Date.now() - cachedWorktrees.loadedAt < 5_000) {
    return cachedWorktrees.worktrees
  }
  const result = await callRuntimeResult<{ worktrees: Worktree[] }>('worktree.list', {
    limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT
  })
  cachedWorktrees = { loadedAt: Date.now(), worktrees: result.worktrees }
  return result.worktrees
}

async function listAllRuntimeDetectedWorktrees(): Promise<Worktree[]> {
  if (cachedDetectedWorktrees && Date.now() - cachedDetectedWorktrees.loadedAt < 5_000) {
    return cachedDetectedWorktrees.worktrees
  }

  // Why a try/catch around the whole thing, not just callRuntimeDetectedWorktrees:
  // an unexpected error from ANY one project's repo.list call (or from
  // project.list itself) shouldn't blank the whole sidebar — this feeds
  // resolveRuntimeWorktreeByPath, whose only caller already handles "no
  // match found" as an expected outcome, not a crash-worthy one.
  try {
    const views = await fetchAllRemoteRepoViews()
    const detectedLists = await Promise.all(
      views.map((view) => callRuntimeDetectedWorktrees(view.id, view.projectId))
    )
    const worktrees = detectedLists.flatMap((result) => result.worktrees)
    cachedDetectedWorktrees = { loadedAt: Date.now(), worktrees }
    return worktrees
  } catch (err) {
    console.error('Failed to list runtime detected worktrees:', err)
    return []
  }
}

async function callRuntimeDetectedWorktrees(
  repoId: string,
  projectId: string
): Promise<DetectedWorktreeListResult> {
  try {
    const response = await callRuntimeEnvelope<DetectedWorktreeListResult>(
      'worktree.detectedList',
      { projectId, repoId },
      15_000
    )
    if (response.ok) {
      // Why the shape guard, kept as defense-in-depth even though
      // channels_worktree.go's handler now synthesizes a real
      // {repoId, authoritative, source, worktrees} (see the spec doc's
      // "Thirty-fourth" entry; mirrors the identical guard store/slices/
      // worktrees.ts's listDetectedWorktreesForRepo has): a server on an
      // older binary mid-rollout, or any future regression in that
      // synthesis, should still degrade safely instead of leaving
      // .worktrees undefined and crashing the very next .flatMap/.map
      // over it above and in resolveRuntimeWorktreeByPath.
      if (!Array.isArray(response.result.worktrees)) {
        return { repoId, authoritative: false, source: 'metadata-fallback', worktrees: [] }
      }
      return response.result
    }
    if (response.error.code !== 'method_not_found') {
      throw new Error(response.error.message)
    }

    const legacy = await callRuntimeResult<{ worktrees: Worktree[] }>(
      'worktree.list',
      { projectId, limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT },
      15_000
    )
    return toLegacyDetectedWorktreeResult(repoId, legacy.worktrees)
  } catch (err) {
    // Why soft-empty here too, not just at the listAll level: PROJECT_
    // MEMBERSHIP_LOOKUP_FAILED/WORKTREE_REPO_NOT_FOUND were known,
    // disclosed architectural gaps (worktree.* not fully wired for
    // project-scoped repos — see the spec doc's "Thirtieth"/"Thirty-first"
    // entries) — now fixed server-side, but kept here defensively for any
    // repo whose dev server genuinely can't be resolved (e.g. one with no
    // dev server bound at all), so a per-repo failure still degrades to
    // "no worktrees detected yet" rather than blanking the whole list.
    const message = err instanceof Error ? err.message : String(err)
    if (
      message.includes('PROJECT_MEMBERSHIP_LOOKUP_FAILED') ||
      message.includes('WORKTREE_REPO_NOT_FOUND')
    ) {
      return { repoId, authoritative: false, source: 'metadata-fallback', worktrees: [] }
    }
    throw err
  }
}

function toLegacyDetectedWorktreeResult(
  repoId: string,
  worktrees: Worktree[]
): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative: true,
    source: 'session-fallback',
    worktrees: worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'orca-managed',
      selectedCheckout: false,
      visible: true
    }))
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /\bENOENT\b|not found|no such file/i.test(error.message)
}

async function resolveRuntimeWorktreeByPath(worktreePath: string): Promise<Worktree> {
  // Why: hidden-but-open worktrees must still resolve for git/file operations.
  // `worktree.list` is sidebar-visible only, so path resolution uses detected rows.
  const worktrees = await listAllRuntimeDetectedWorktrees()
  const match = worktrees
    .map((worktree) => ({
      worktree,
      relativePath: relativePathInsideRoot(worktree.path, worktreePath)
    }))
    .filter((entry) => entry.relativePath !== null)
    .sort((a, b) => b.worktree.path.length - a.worktree.path.length)[0]
  if (!match) {
    throw new Error(`No runtime worktree owns ${worktreePath}`)
  }
  return match.worktree
}

async function resolveRuntimeFilePath(
  filePath: string,
  preferredWorktreePath?: string
): Promise<{ worktree: Worktree; relativePath: string }> {
  const worktree = preferredWorktreePath
    ? await resolveRuntimeWorktreeByPath(preferredWorktreePath)
    : await resolveRuntimeWorktreeByPath(filePath)
  const relativePath = relativePathInsideRoot(worktree.path, filePath)
  if (relativePath === null) {
    throw new Error(`File is outside runtime worktree: ${filePath}`)
  }
  return { worktree, relativePath }
}

async function mutateGitPath(
  method: string,
  worktreePath: string,
  filePath: string
): Promise<void> {
  const file = await resolveRuntimeFilePath(filePath, worktreePath)
  await callRuntimeResult(method, {
    worktree: toRuntimeWorktreeSelector(file.worktree.id),
    filePath: file.relativePath
  })
}

async function mutateGitPaths(
  method: string,
  worktreePath: string,
  filePaths: string[]
): Promise<void> {
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  await callRuntimeResult(method, { worktree: toRuntimeWorktreeSelector(worktree.id), filePaths })
}

function mapRepoPathArg(args: unknown): unknown {
  if (!args || typeof args !== 'object' || !('repoPath' in args)) {
    return args
  }
  const record = args as Record<string, unknown>
  const repoId = typeof record.repoId === 'string' && record.repoId.trim() ? record.repoId : null
  return {
    ...record,
    // Why: runtime repo selectors accept loose path/name forms, but duplicate
    // checked-out repos can make those ambiguous. The renderer already passes
    // Orca's repo id on task calls, so prefer the explicit selector.
    repo: repoId ? `id:${repoId}` : record.repoPath
  }
}

function mapRuntimeNamespaceArg(prefix: string, args: unknown): unknown {
  if (prefix !== 'hostedReview') {
    return args
  }
  return mapRepoPathArg(args)
}

function createEmptyMemorySnapshot(): MemorySnapshot {
  const emptyUsage = { cpu: 0, memory: 0 }
  return {
    app: { ...emptyUsage, main: emptyUsage, renderer: emptyUsage, other: emptyUsage, history: [] },
    worktrees: [],
    host: {
      totalMemory: 0,
      freeMemory: 0,
      usedMemory: 0,
      memoryUsagePercent: 0,
      cpuCoreCount: navigator.hardwareConcurrency || 1,
      loadAverage1m: 0
    },
    totalCpu: 0,
    totalMemory: 0,
    collectedAt: Date.now()
  }
}

function getBrowserPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Windows')) {
    return 'win32'
  }
  if (navigator.userAgent.includes('Linux')) {
    return 'linux'
  }
  return 'darwin'
}

function readJson<T>(key: string, fallback: T): T {
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return cloneJson(fallback)
  }
  try {
    return { ...cloneJson(fallback), ...JSON.parse(raw) } as T
  } catch {
    return cloneJson(fallback)
  }
}

function writeJson<T>(key: string, value: T): void {
  window.localStorage.setItem(key, JSON.stringify(value))
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function withFallback<T extends object>(target: T, path: string[]): T {
  return new Proxy(target, {
    get(current, property, receiver) {
      if (property in current) {
        const value = Reflect.get(current, property, receiver) as unknown
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return withFallback(value as object, [...path, String(property)])
        }
        return value
      }
      return createFallbackProxy([...path, String(property)])
    }
  })
}

function createFallbackProxy(
  path: string[],
  applyOverride?: (path: string[], args: unknown[]) => unknown
): never {
  const fn = () => undefined
  return new Proxy(fn, {
    get(_target, property) {
      if (property === 'then') {
        return undefined
      }
      return createFallbackProxy([...path, String(property)], applyOverride)
    },
    apply(_target, _thisArg, args) {
      if (applyOverride) {
        return applyOverride(path, args)
      }
      return getFallbackResult(path, args)
    }
  }) as never
}

function getFallbackResult(path: string[], args: unknown[]): unknown {
  const name = path.at(-1) ?? ''
  if (name.startsWith('on')) {
    return noopUnsubscribe
  }
  if (name.startsWith('is') || name.startsWith('has') || name === 'pathExists') {
    return Promise.resolve(false)
  }
  if (name.startsWith('list') || name.startsWith('detect')) {
    return Promise.resolve([])
  }
  if (name.startsWith('preview')) {
    return Promise.resolve({ found: false, diff: {}, unsupportedKeys: [] })
  }
  if (name.startsWith('get') && name.endsWith('Status')) {
    return Promise.resolve([])
  }
  if (name === 'write' || name === 'resize' || name === 'reportGeometry') {
    return undefined
  }
  if (args.length === 0 && (name === 'getZoomLevel' || name === 'declarePendingPaneSerializer')) {
    return 0
  }
  return Promise.resolve(undefined)
}

function noopUnsubscribe(): void {}
