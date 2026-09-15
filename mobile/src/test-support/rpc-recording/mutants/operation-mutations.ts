import type { OperationMutation } from '../operation-module-loader'

/**
 * One in-memory source edit per adapter family. Each anchor names a real expression in a mounted
 * operation; the recording that owns the family must change visible state when it is applied, which
 * is what proves that family's `state()` projection observes the operation's actual output.
 */
export const OPERATION_MUTATIONS = {
  // Drops the delivery-unknown arm of a native-chat send, so an ack lost after the frame was
  // written reads as a definite rejection and invites the user to send the same message twice.
  'native-chat-send-delivery-unknown': {
    file: 'mobile-native-chat-send.ts',
    before: `    return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
      ? 'unknown'
      : 'rejected'`,
    after: `    return isLogicalClientCutoverError(error) ? 'unknown' : 'rejected'`
  },
  // Re-anchored where the operation migration moved the acceptance read; the defect it injects —
  // a stale workspace response poisoning the search cache — is unchanged.
  race: {
    file: 'use-mobile-native-chat-file-search.ts',
    before: '!accepted.accepted || generationRef.current !== generation',
    after: '!accepted.accepted'
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
  // Interprets inside the request chain instead of at the declared barrier, so the issue leg
  // rejects the group early and the sibling comment request is abandoned out of order. Re-anchored
  // where the operation migration moved the send; the defect it injects is unchanged.
  order: {
    file: 'use-mobile-tasks-item-detail-loading.tsx',
    before: `        linearIssueRead.request(
          client,
          {
            id: actionItem.source.id,
            workspaceId: actionItem.source.workspaceId
          },
          { timeoutMs: 30_000 }
        ),`,
    after: `        linearIssueRead
          .request(
            client,
            {
              id: actionItem.source.id,
              workspaceId: actionItem.source.workspaceId
            },
            { timeoutMs: 30_000 }
          )
          .then((response) => {
            linearIssueRead.interpret(response)
            return response
          }),`
  },
  // Reads the overrides one level above the settings envelope.
  'bot-overrides-envelope': {
    file: 'settings-read-operations.ts',
    before: "settings == null ? undefined : settingsField(settings, 'prBotAuthorOverrides')",
    after: "raw == null ? undefined : settingsField(raw, 'prBotAuthorOverrides')"
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
  // Moves the optimistic preset write behind the guard that only an unusable client takes, so the
  // preset the screen shows never follows the tap. Anchored above the send so the step-4 migration
  // of this file does not move it; the projection it proves load-bearing is the same one.
  'task-preferences-optimistic': {
    file: 'use-mobile-tasks-client-settings-actions.tsx',
    before: `      setDefaultGitHubPreset(preset)
      if (!client || !taskUiReady) {
        return
      }`,
    after: `      if (!client || !taskUiReady) {
        setDefaultGitHubPreset(preset)
        return
      }`
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
  // Re-anchored where the operation migration moved both reads; the reorder it injects — the
  // detection refusal deciding the error before the settings read is interpreted — is unchanged.
  'new-tab-refusal-order': {
    file: 'mobile-new-tab-agent-loader.ts',
    before: `  const readSettings = newTabSettingsRead.interpret(settingsResponse)`,
    after: `  const detected0 = detectedAgents.interpret(detectedAgents.reply)
  void detected0
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
} as const satisfies Record<string, Omit<OperationMutation, 'name'>>

export type Mutation = keyof typeof OPERATION_MUTATIONS

/** The spec the loader applies, carrying the name only so a half-applied anchor can report it. */
export function operationMutation(name: Mutation): OperationMutation {
  return { name, ...OPERATION_MUTATIONS[name] }
}
