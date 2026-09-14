/**
 * One in-memory source edit per adapter family. Each anchor names a real expression in a mounted
 * operation; the recording that owns the family must change visible state when it is applied, which
 * is what proves that family's `state()` projection observes the operation's actual output.
 */
export type OperationMutation = {
  /** Suffix of the mounted source file the anchor belongs to. */
  file: string
  before: string
  after: string
}

export const OPERATION_MUTATIONS = {
  // Loses the generation comparison, so a stale workspace response poisons the search cache.
  race: {
    file: 'use-mobile-native-chat-file-search.ts',
    before: '!response.ok || generationRef.current !== generation',
    after: '!response.ok'
  },
  // Accepts a null result envelope instead of rejecting it. The guard is repeated for three
  // mutations in this file; the anchor carries the message so only the recorded one is edited.
  acceptance: {
    file: 'use-mobile-tasks-project-metadata-actions.tsx',
    before: `if (result.ok === false) {
          throw new Error(result.error?.message ?? 'Failed to update GitHub item')`,
    after: `if (result?.ok === false) {
          throw new Error(result.error?.message ?? 'Failed to update GitHub item')`
  },
  // Rejects the barrier early, so the sibling comment request is abandoned out of order.
  order: {
    file: 'use-mobile-tasks-item-detail-loading.tsx',
    before: `{ timeoutMs: 30_000 }
        ),
        client.sendRequest(
          'linear.issueComments'`,
    after: `{ timeoutMs: 30_000 }
        ).then((response) => { if (!isSuccess(response)) throw new Error(response.error.message); return response }),
        client.sendRequest(
          'linear.issueComments'`
  },
  // Reads the overrides one level above the settings envelope.
  'bot-overrides-envelope': {
    file: 'settings-read-operations.ts',
    before: "settings == null ? undefined : Reflect.get(Object(settings), 'prBotAuthorOverrides')",
    after: "raw == null ? undefined : Reflect.get(Object(raw), 'prBotAuthorOverrides')"
  },
  // Publishes the settings envelope instead of the accepted operation value.
  'workspace-context-envelope': {
    file: 'use-new-workspace-runtime-context.ts',
    before:
      '(settingsResult.value as NewWorktreeRuntimeSettings & { visibleTaskProviders?: unknown })',
    after:
      '(settingsRes.value.result as NewWorktreeRuntimeSettings & { visibleTaskProviders?: unknown })'
  },
  // Treats any successful linear.status reply as a connected Linear account.
  'home-providers-linear': {
    file: 'mobile-home-host-requests.ts',
    before: 'linearConnected: linear?.connected === true',
    after: 'linearConnected: linear !== null'
  },
  // Reads the host platform from the wrong field of the host.platform result.
  'repo-metadata-platform': {
    file: 'use-host-repo-metadata.ts',
    before: 'const platform = (result as { platform?: unknown } | null)?.platform',
    after: 'const platform = (result as { hostPlatform?: unknown } | null)?.hostPlatform'
  },
  // Hydrates the runtime task settings from the envelope rather than the accepted value.
  'task-hydration-envelope': {
    file: 'use-mobile-tasks-runtime-hydration.tsx',
    before: '((settingsResult.value ?? {}) as RuntimeTaskSettings)',
    after: '((settingsResponse.result ?? {}) as RuntimeTaskSettings)'
  },
  // Applies the preset only after the write settles, dropping the optimistic update.
  'task-preferences-optimistic': {
    file: 'use-mobile-tasks-client-settings-actions.tsx',
    before: `      setDefaultGitHubPreset(preset)
      if (!client || !taskUiReady) {
        return
      }
      void client.sendRequest('settings.update', { defaultTaskViewPreset: preset }).catch(() => {`,
    after: `      if (!client || !taskUiReady) {
        setDefaultGitHubPreset(preset)
        return
      }
      void client
        .sendRequest('settings.update', { defaultTaskViewPreset: preset })
        .then(() => setDefaultGitHubPreset(preset))
        .catch(() => {`
  },
  // Publishes the settings envelope as the refreshed workspace runtime settings.
  'workspace-submit-envelope': {
    file: 'use-new-workspace-create-submit.ts',
    before: 'latestRuntimeSettings = settings.value as NewWorktreeRuntimeSettings',
    after: 'latestRuntimeSettings = settingsReply.result as NewWorktreeRuntimeSettings'
  },
  // Reads settings eagerly, so a null result throws before the sibling's refusal is checked.
  'new-tab-deferred-settings-read': {
    file: 'settings-read-operations.ts',
    before: '  value: () => settingsMember(raw),',
    after: '  value: ((settings) => () => settings)(settingsMember(raw)),'
  },
  // Checks the sibling's refusal before the operation's own, so a correlated refusal reports the
  // sibling. Invisible to every scenario whose sibling succeeds or rejects at the transport.
  'new-tab-refusal-order': {
    file: 'mobile-new-tab-agent-loader.ts',
    before: `  const readSettings = newTabSettingsRead.interpret(settingsResponse)
  if (!detectedResponse.ok) {
    throw new Error((detectedResponse as RpcFailure).error.message)
  }`,
    after: `  if (!detectedResponse.ok) {
    throw new Error((detectedResponse as RpcFailure).error.message)
  }
  const readSettings = newTabSettingsRead.interpret(settingsResponse)`
  },
  // Publishes an unaccepted read, blanking settings a refusal should have left alone. Invisible
  // to any scenario that refuses before the screen ever held data.
  'workspace-context-refusal-blanks': {
    file: 'use-new-workspace-runtime-context.ts',
    before: `      if (settingsValue) {
        setRuntimeSettings(settingsValue)
      }`,
    after: '      setRuntimeSettings(settingsValue)'
  },
  // Publishes the settings envelope as the refreshed task runtime settings.
  'task-workspace-envelope': {
    file: 'use-mobile-tasks-workspace-create-actions.tsx',
    before: 'latestRuntimeTaskSettings = (settingsResult.value ?? {}) as RuntimeTaskSettings',
    after: 'latestRuntimeTaskSettings = (settingsReply.result ?? {}) as RuntimeTaskSettings'
  }
} as const satisfies Record<string, OperationMutation>

export type Mutation = keyof typeof OPERATION_MUTATIONS

/**
 * Appended to a mounted module after transpile, keyed by file suffix. An adapter drives a real
 * operation the product keeps module-private; exposing it here beats editing the pinned source.
 */
export const OPERATION_EXPOSURES: readonly (readonly [string, string])[] = [
  [
    'MobileAgentSessionHistoryPanel.tsx',
    '\nexports.loadMobileResumeMetadata = loadMobileResumeMetadata;'
  ]
]
