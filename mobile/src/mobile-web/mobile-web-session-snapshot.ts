import type { MobileWebHostWorkspaceId } from './mobile-web-workspace-authority'
import { AGENT_TYPE_MAX_LENGTH } from '../../../src/shared/agent-status-types'
import {
  MobileWebRelativePathSchema,
  MOBILE_WEB_SESSION_TAB_LIMIT,
  MobileWebSessionSnapshotResultSchema,
  type MobileWebSessionSnapshotResult,
  type MobileWebSessionTab
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import { mobileWebPageBrowserUrl } from '../../../src/shared/mobile-web/browser-url-privacy'
import { mobileWebSessionAgentStatus } from './mobile-web-session-agent-status-projection'
import { tabsWithinMobileWebSessionEventBudget } from './mobile-web-session-snapshot-event-budget'
import {
  boundedNullableText,
  boundedOptionalText,
  boundedText
} from './mobile-web-session-value-bounds'
import type { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import type {
  MobileWebHostNativeChatBinding,
  MobileWebNativeChatAuthority
} from './mobile-web-native-chat-authority'

const TAB_TYPES = ['terminal', 'markdown', 'file', 'browser'] as const

export function mobileWebSessionSnapshot(
  result: unknown,
  hostWorkspaceId: MobileWebHostWorkspaceId,
  pageWorkspaceId: string,
  browserAuthority: MobileWebBrowserAuthority,
  nativeChatAuthority: MobileWebNativeChatAuthority
): MobileWebSessionSnapshotResult {
  if (
    !isRecord(result) ||
    result.worktree !== hostWorkspaceId ||
    typeof result.publicationEpoch !== 'string' ||
    !result.publicationEpoch ||
    result.publicationEpoch.length > 128 ||
    typeof result.snapshotVersion !== 'number' ||
    !Number.isSafeInteger(result.snapshotVersion) ||
    result.snapshotVersion < 0 ||
    !Array.isArray(result.tabs)
  ) {
    throw new Error('mobile_web_session_snapshot_invalid')
  }

  const browserPageIds = result.tabs.flatMap((value): string[] => {
    if (
      isRecord(value) &&
      value.type === 'browser' &&
      typeof value.browserPageId === 'string' &&
      value.browserPageId.length > 0 &&
      value.browserPageId.length <= 512
    ) {
      return [value.browserPageId]
    }
    return []
  })
  browserAuthority.synchronizeWorkspace(hostWorkspaceId, browserPageIds)
  const nativeChatBindings = result.tabs.flatMap((value): MobileWebHostNativeChatBinding[] => {
    const binding = mobileWebNativeChatBinding(value, hostWorkspaceId)
    return binding ? [binding] : []
  })
  nativeChatAuthority.synchronizeWorkspace(hostWorkspaceId, nativeChatBindings)
  const tabs = boundedHostSessionTabs(result.tabs).flatMap((value): MobileWebSessionTab[] => {
    const tab = mobileWebSessionTab(value, hostWorkspaceId, browserAuthority, nativeChatAuthority)
    return tab ? [tab] : []
  })
  const activeTabId =
    result.activeTabType === 'browser'
      ? (tabs.find((tab) => tab.type === 'browser' && tab.isActive)?.id ?? null)
      : boundedNullableText(result.activeTabId, 512)

  const envelope = {
    workspaceId: pageWorkspaceId,
    publicationEpoch: result.publicationEpoch,
    snapshotVersion: result.snapshotVersion,
    workspaceTransportState:
      result.workspaceTransportState === 'unavailable' ? 'unavailable' : 'available',
    activeTabId,
    activeTabType: isTabType(result.activeTabType) ? result.activeTabType : null
  }
  const boundedTabs = tabsWithinMobileWebSessionEventBudget(envelope, tabs)
  const parsed = MobileWebSessionSnapshotResultSchema.safeParse({
    ...envelope,
    tabs: boundedTabs,
    truncated: result.tabs.length > boundedTabs.length
  })
  if (!parsed.success) {
    throw new Error('mobile_web_session_snapshot_invalid')
  }
  return parsed.data
}

function boundedHostSessionTabs(tabs: unknown[]): unknown[] {
  const bounded = tabs.slice(0, MOBILE_WEB_SESSION_TAB_LIMIT)
  if (tabs.length <= MOBILE_WEB_SESSION_TAB_LIMIT || bounded.some(isActiveSessionTab)) {
    return bounded
  }
  const active = tabs.find(isActiveSessionTab)
  return active ? [...bounded.slice(0, -1), active] : bounded
}

function isActiveSessionTab(value: unknown): boolean {
  return isRecord(value) && value.isActive === true
}

function mobileWebSessionTab(
  value: unknown,
  hostWorkspaceId: MobileWebHostWorkspaceId,
  browserAuthority: MobileWebBrowserAuthority,
  nativeChatAuthority: MobileWebNativeChatAuthority
): MobileWebSessionTab | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 512 ||
    !isTabType(value.type)
  ) {
    return null
  }
  const base = {
    id: value.id,
    title: boundedText(value.title, 240, fallbackTitle(value.type)),
    isActive: value.isActive === true
  }
  if (value.type === 'terminal') {
    const launchAgent = boundedOptionalText(value.launchAgent, AGENT_TYPE_MAX_LENGTH)
    const agentStatus = mobileWebSessionAgentStatus(value.agentStatus)
    const nativeChatBinding = mobileWebNativeChatBinding(value, hostWorkspaceId)
    return {
      ...base,
      type: 'terminal',
      status: value.status === 'pending-handle' ? 'pending-handle' : 'ready',
      ...(launchAgent ? { launchAgent } : {}),
      ...(agentStatus ? { agentStatus } : {}),
      ...(nativeChatBinding
        ? { nativeChatSessionId: nativeChatAuthority.register(nativeChatBinding) }
        : {})
    }
  }
  if (value.type === 'markdown') {
    const relativePath = safeRelativePath(value.relativePath)
    return {
      ...base,
      type: 'markdown',
      ...(relativePath ? { relativePath } : {}),
      isDirty: value.isDirty === true,
      ...(value.language === 'markdown' ? { language: 'markdown' as const } : {}),
      ...(value.mode === 'edit' || value.mode === 'markdown-preview' ? { mode: value.mode } : {})
    }
  }
  if (value.type === 'file') {
    const relativePath = safeRelativePath(value.relativePath)
    const language = boundedLanguage(value.language)
    const mode = value.mode === 'edit' || value.mode === 'diff' ? value.mode : undefined
    const diffSource = isFileDiffSource(value.diffSource) ? value.diffSource : undefined
    return {
      ...base,
      type: 'file',
      ...(relativePath ? { relativePath } : {}),
      ...(language ? { language } : {}),
      ...(mode ? { mode } : {}),
      ...(diffSource ? { diffSource } : {})
    }
  }
  if (
    typeof value.browserPageId !== 'string' ||
    !value.browserPageId ||
    value.browserPageId.length > 512
  ) {
    return null
  }
  const browserPageId = browserAuthority.register(hostWorkspaceId, value.browserPageId)
  return {
    ...base,
    id: browserPageId,
    type: 'browser',
    browserPageId,
    url: mobileWebPageBrowserUrl(value.url),
    loading: value.loading === true,
    canGoBack: value.canGoBack === true,
    canGoForward: value.canGoForward === true
  }
}

function fallbackTitle(type: MobileWebSessionTab['type']): string {
  return type === 'browser' ? 'Browser' : type[0].toUpperCase() + type.slice(1)
}

function mobileWebNativeChatBinding(
  value: unknown,
  hostWorkspaceId: MobileWebHostWorkspaceId
): MobileWebHostNativeChatBinding | null {
  if (
    !isRecord(value) ||
    value.type !== 'terminal' ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > 512 ||
    !isRecord(value.agentStatus) ||
    !isRecord(value.agentStatus.providerSession)
  ) {
    return null
  }
  const agent =
    boundedOptionalText(value.agentStatus.agentType, AGENT_TYPE_MAX_LENGTH) ??
    boundedOptionalText(value.launchAgent, AGENT_TYPE_MAX_LENGTH)
  const providerSessionId = boundedOptionalText(value.agentStatus.providerSession.id, 512)
  if (!agent || !providerSessionId) {
    return null
  }
  const transcriptPath = boundedOptionalText(
    value.agentStatus.providerSession.transcriptPath,
    16 * 1024
  )
  return {
    hostWorkspaceId,
    hostTabId: value.id,
    hostTerminalId:
      typeof value.terminal === 'string' && value.terminal.length > 0 ? value.terminal : null,
    agent,
    providerSessionId,
    ...(transcriptPath ? { transcriptPath } : {})
  }
}

function isTabType(value: unknown): value is (typeof TAB_TYPES)[number] {
  return TAB_TYPES.some((type) => type === value)
}

function safeRelativePath(value: unknown): string | undefined {
  const parsed = MobileWebRelativePathSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function boundedLanguage(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_+.-]{1,64}$/.test(value) ? value : undefined
}

function isFileDiffSource(value: unknown): value is 'staged' | 'unstaged' | 'branch' | 'commit' {
  return value === 'staged' || value === 'unstaged' || value === 'branch' || value === 'commit'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
