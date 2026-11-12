// Unknown state belongs to the profile; only deliberate user configuration is shared.
const SHARED_CONFIG_KEYS = [
  'apiKeyHelper',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'theme',
  'verbose',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'autoScrollEnabled',
  'showTurnDuration',
  'externalEditorContext',
  'showMessageTimestamps',
  'diffTool',
  'env',
  'todoFeatureEnabled',
  'showExpandedTodos',
  'briefTranscript',
  'diffSidebarOpen',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'respectGitignore',
  'claudeInChromeDefaultEnabled',
  'hasCompletedClaudeInChromeOnboarding',
  'lspRecommendationDisabled',
  'lspRecommendationNeverPlugins',
  'copyFullResponse',
  'copyOnSelect',
  'leftArrowOpensAgents',
  'defaultToAgentsView',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'autoUploadSessions',
  'autoAddRemoteControlDaemonWorker',
  'remoteDialogSeen',
  'workflowSizeGuideline',
  'favoritePlugins',
  'preferTmuxOverIterm2',
  'codeReviewLastEffort',
  'codeReviewLastMaxFindings',
  'bypassPermissionsModeAccepted',
  'mcpServers'
] as const

const SHARED_PROJECT_KEYS = [
  'allowedTools',
  'mcpContextUris',
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'hasClaudeMdExternalIncludesApproved',
  'hasTrustDialogAccepted'
] as const

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function selectConfigFields(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]])
  )
}

export function selectSharedClaudeProfileState(
  source: Record<string, unknown>
): Record<string, unknown> {
  const shared = selectConfigFields(source, SHARED_CONFIG_KEYS)
  if (isPlainRecord(source.projects)) {
    const projects: Record<string, unknown> = {}
    for (const [path, entry] of Object.entries(source.projects)) {
      if (isPlainRecord(entry)) {
        const selected = selectConfigFields(entry, SHARED_PROJECT_KEYS)
        if (Object.keys(selected).length > 0) {
          projects[path] = selected
        }
      }
    }
    if (Object.keys(projects).length > 0) {
      shared.projects = projects
    }
  }
  if (source.hasCompletedOnboarding === true) {
    shared.hasCompletedOnboarding = true
  }
  if (
    isPlainRecord(source.customApiKeyResponses) &&
    Array.isArray(source.customApiKeyResponses.rejected)
  ) {
    const rejected = source.customApiKeyResponses.rejected.filter(
      (value) => typeof value === 'string'
    )
    if (rejected.length > 0) {
      shared.customApiKeyResponses = { rejected }
    }
  }
  return shared
}

function mergeProjects(current: unknown, source: Record<string, unknown>): unknown {
  if (current !== undefined && !isPlainRecord(current)) {
    return current
  }
  const projects: Record<string, unknown> = { ...current }
  for (const [path, entry] of Object.entries(source)) {
    const own = projects[path]
    if (isPlainRecord(entry) && (own === undefined || isPlainRecord(own))) {
      projects[path] = {
        ...own,
        ...entry,
        ...(own?.hasTrustDialogAccepted === true ? { hasTrustDialogAccepted: true } : {})
      }
    }
  }
  return projects
}

function mergeRejectedApiKeys(current: unknown, source: Record<string, unknown>): unknown {
  if (current !== undefined && !isPlainRecord(current)) {
    return current
  }
  const previous = current?.rejected
  if ((previous !== undefined && !Array.isArray(previous)) || !Array.isArray(source.rejected)) {
    return current
  }
  const rejected = [...(previous ?? [])]
  const seen = new Set(rejected)
  for (const value of source.rejected) {
    if (!seen.has(value)) {
      seen.add(value)
      rejected.push(value)
    }
  }
  return { ...current, rejected }
}

export function mergeClaudeProfileState(
  current: Record<string, unknown>,
  shared: Record<string, unknown>
): Record<string, unknown> {
  const config = { ...current }
  for (const [key, value] of Object.entries(shared)) {
    if (key === 'hasCompletedOnboarding') {
      if (!Object.hasOwn(current, key)) {
        config[key] = true
      }
    } else if (key === 'customApiKeyResponses' && isPlainRecord(value)) {
      config[key] = mergeRejectedApiKeys(current[key], value)
    } else if (key === 'projects' && isPlainRecord(value)) {
      config[key] = mergeProjects(current[key], value)
    } else if (key === 'mcpServers' && isPlainRecord(current[key]) && isPlainRecord(value)) {
      config[key] = { ...current[key], ...value }
    } else {
      config[key] = value
    }
  }
  return config
}
