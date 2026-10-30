import type { OperationMutation } from '../operation-module-loader'

// Each anchored mutation must change its family’s recorded output to prove that projection observes product behavior.
export const OPERATION_MUTATIONS = {
  // Lost acknowledgements must remain unknown; treating them as rejection invites duplicate sends.
  'native-chat-send-delivery-unknown': {
    file: 'mobile-native-chat-send.ts',
    before: `    return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
      ? 'unknown'
      : 'rejected'`,
    after: `    return isLogicalClientCutoverError(error) ? 'unknown' : 'rejected'`
  },
  // Bypass the owner’s generation guard to poison search with a stale workspace reply.
  race: {
    file: 'generation-scoped-request-owner.ts',
    before: `    if (state.generation !== this.currentGeneration) {
      return 'retired-generation'
    }
`,
    after: ''
  },
  // Loosen the schema so null reaches result.ok and reproduces the unchecked property-read failure.
  acceptance: {
    file: 'task-project-board-reply-schema.ts',
    before: `export const taskProjectMutationStatusSchema = z.looseObject({
  ok: optionalOk,
  error: optionalProjectError
})`,
    after: `export const taskProjectMutationStatusSchema = z.unknown()`
  },
  // Interpret before the barrier so an issue refusal abandons sibling comments out of order.
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
  // Decodes the reply envelope instead of the accepted snapshot, so the Home card publishes nothing
  // where a host answered.
  'home-accounts-envelope': {
    file: 'mobile-home-host-requests.ts',
    before: 'const snapshot = decodeAccountsSnapshot(accounts.value)',
    after: 'const snapshot = decodeAccountsSnapshot(reply)'
  },
  // Offset-zero chunk writes preserve length; digest and decoded-byte observations must detect corruption.
  'mobile-web-bundle-chunk-placement': {
    file: 'mobile-web-bundle-fetch.ts',
    before: 'whole.set(bytes, offset)',
    after: 'whole.set(bytes, 0)'
  },
  // Bypass reply checks so malformed catalog responses reach admission and can blank the host (STA-3123).
  'worktree-catalog-unchecked-reader': {
    file: 'worktree-catalog-operations.ts',
    before: "read: rpcResultVariant('worktree-catalog', worktreeCatalogSchema)",
    after:
      "read: (raw: unknown) => ({ compatible: true, variant: 'worktree-catalog', value: raw, salvage: { droppedPaths: [], droppedCount: 0 } })"
  },
  // Read the wrong envelope level so an accepted push test reports failure.
  'push-test-envelope': {
    file: 'notification-display-test.tsx',
    before: 'const result = delivered.value',
    after: 'const result = reply as unknown as typeof delivered.value'
  },
  // Publishes the repo reply's payload instead of the member the reader took off it.
  'task-screen-repo-envelope': {
    file: 'use-mobile-tasks-route-and-item-state.tsx',
    before: 'return newTabRepoListRead.interpret(reply) as RepoSummary[]',
    after: 'return (reply as { result?: unknown }).result as RepoSummary[]'
  },
  // Drops the context reload the workspace switch chains off its send, so the sheet keeps showing
  // the previous workspace's teams after the host accepted the change.
  'linear-workspace-context-reload': {
    file: 'mobile-tasks-filter-pickers.tsx',
    before: `          void linearWorkspaceSelect
            .request(client, { workspaceId })
            .then(() => loadLinearContext())`,
    after: `          void linearWorkspaceSelect
            .request(client, { workspaceId })
            .then(() => undefined)`
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
  // Read the wrong host-platform field so rows display an unreported platform.
  'repo-metadata-platform': {
    file: 'host-screen-reply-schema.ts',
    before: `  .looseObject({ platform: salvagedOptional('platform', z.enum(NODE_PLATFORM_NAMES)) })
  .transform((reply) => reply.platform ?? null)`,
    after: `  .looseObject({
    platform: salvagedOptional('platform', z.enum(NODE_PLATFORM_NAMES)),
    hostPlatform: salvagedOptional('hostPlatform', z.enum(NODE_PLATFORM_NAMES))
  })
  .transform((reply) => reply.hostPlatform ?? null)`
  },
  // Hydrates the runtime task settings from the envelope rather than the accepted value.
  'task-hydration-envelope': {
    file: 'use-mobile-tasks-runtime-hydration.tsx',
    before: '((settingsResult.value ?? {}) as RuntimeTaskSettings)',
    after: '((settingsResponse.result ?? {}) as RuntimeTaskSettings)'
  },
  // Gate the optimistic write on an unusable client so the displayed preset never follows the tap.
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
  // Give the sibling refusal precedence; only correlated-refusal scenarios detect this ordering.
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
  // Keep a refused send’s draft cleared, losing the user’s input.
  'terminal-send-refusal-restores-draft': {
    file: 'use-mobile-session-terminal-send-actions.ts',
    before: `      if (!accepted) {
        restoreRejectedDraft()
      }`,
    after: `      if (accepted) {
        restoreRejectedDraft()
      }`
  },
  // Resolves the connection of whichever repo the host listed first instead of the workspace's own,
  // so a terminal opens against a different machine than the one the workspace lives on.
  'worktree-connection-first-repo': {
    file: 'use-mobile-session-accessory-selection.ts',
    before: 'return repos.find((repo) => repo.id === repoId)?.connectionId?.trim() || null',
    after: 'return repos[0]?.connectionId?.trim() || null'
  },
  // Routes a refused checks reply back through the sidebar's failure classifier, so a checks leg
  // the reader could not read takes the whole sidebar to `error` and the PR the user opened it for
  // disappears behind a retry.
  'pr-sidebar-checks-failure-state': {
    file: 'mobile-pr-sidebar-state.ts',
    before: `      return {
        kind: 'ready',
        data: {
          pr,
          details: null,
          checks: [],
          checksError: checksOutcome.error,
          pushTarget: link.pushTarget
        }
      }`,
    after: '      return failureState(checksOutcome.error)'
  },
  // Always send the client member so tokenless phones falsely claim presence.
  'display-mode-unconditional-client': {
    file: 'use-mobile-session-terminal-stream-display.ts',
    before: `          ...(deviceTokenRef.current
            ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
            : {}),`,
    after: `          client: { id: deviceTokenRef.current, type: 'mobile' as const },`
  },
  // Send unmeasured viewport cells on auto toggles, replacing stored dimensions with null.
  'display-mode-unmeasured-viewport': {
    file: 'use-mobile-session-terminal-stream-display.ts',
    before: `          ...(viewportRef.current && next === 'auto' ? { viewport: viewportRef.current } : {})`,
    after: `          ...(next === 'auto' ? { viewport: viewportRef.current } : {})`
  },
  // Send null instead of omitting afterTabId; only sessions without an active tab detect it.
  'create-after-tab-id-null': {
    file: 'use-mobile-session-terminal-create-actions.ts',
    before: '      const afterTabId = activeSessionTabId ?? undefined',
    after: '      const afterTabId = activeSessionTabId'
  },
  // Swap shell command and agent prompt; empty-option scenarios cannot detect it.
  'create-quick-command-keys': {
    file: 'mobile-session-terminal-create-request.ts',
    before: `    ...(options?.startupCommand ? { command: options.startupCommand } : {}),
    ...(options?.startupCommandDelivery
      ? { startupCommandDelivery: options.startupCommandDelivery }
      : {}),
    ...(options?.agentPrompt ? { agentPrompt: options.agentPrompt } : {}),`,
    after: `    ...(options?.startupCommand ? { agentPrompt: options.startupCommand } : {}),
    ...(options?.startupCommandDelivery
      ? { startupCommandDelivery: options.startupCommandDelivery }
      : {}),
    ...(options?.agentPrompt ? { command: options.agentPrompt } : {}),`
  },
  // Remove the in-flight guard; only overlapping taps expose duplicate terminals.
  'create-second-tap-in-flight': {
    file: 'use-mobile-session-terminal-create-actions.ts',
    before: '    if (creatingTerminalRef.current) {',
    after: '    if (false && creatingTerminalRef.current) {'
  },
  // Let tab-load refusal abort terminal loading/refresh timers; this scenario has no created activation timer.
  'startup-tab-load-rejects-sequence': {
    file: 'use-mobile-session-startup.ts',
    before: '      await ensureSessionTabs().catch(() => null)',
    after: '      await ensureSessionTabs()'
  },
  // Accept null Linear status; only result-null reaches the resulting connected property-read failure.
  'linear-status-nullable': {
    file: 'task-list-reply-schema.ts',
    before: `  activeWorkspaceId: salvagedOptional('activeWorkspaceId', z.string().nullable())
})`,
    after: `  activeWorkspaceId: salvagedOptional('activeWorkspaceId', z.string().nullable())
}).nullable()`
  },
  // Collapse explicit avatarUrl:null to absence; picker rendering alone cannot distinguish them.
  'assignable-user-avatar-null-collapse': {
    file: 'task-provider-entity-reply-schema.ts',
    before: `  name: prNullableText('name'),
  avatarUrl: prNullableText('avatarUrl')`,
    after: `  name: prNullableText('name'),
  avatarUrl: prText('avatarUrl')`
  },
  // Publishes the settings envelope as the refreshed task runtime settings.
  'task-workspace-envelope': {
    file: 'use-mobile-tasks-workspace-create-actions.tsx',
    before: 'latestRuntimeTaskSettings = (settingsResult.value ?? {}) as RuntimeTaskSettings',
    after: 'latestRuntimeTaskSettings = (settingsReply.result ?? {}) as RuntimeTaskSettings'
  }
} as const satisfies Record<string, Omit<OperationMutation, 'name'>>

export type Mutation = keyof typeof OPERATION_MUTATIONS

export function operationMutation(name: Mutation): OperationMutation {
  return { name, ...OPERATION_MUTATIONS[name] }
}
