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
  // Re-anchored where the lifecycle migration moved the guard: the hand-rolled generation compare
  // became the owner's, so the anchor is the owner's compare. The defect it injects — a stale
  // workspace response poisoning the search cache — is unchanged.
  race: {
    file: 'generation-scoped-request-owner.ts',
    before: `    if (state.generation !== this.currentGeneration) {
      return 'retired-generation'
    }
`,
    after: ''
  },
  // Re-anchored where step 7 moved the defence. The b2 seed's defect is a null result envelope
  // reaching the metadata sheet, and the call-site guard it used to be injected at can no longer
  // see one: the checked reader refuses the envelope first. So the anchor is the schema, and
  // loosening it to `z.unknown()` puts the null back on the path to `result.ok` — which is main's
  // own property-read TypeError, and a different visible error from the reply the reader names.
  acceptance: {
    file: 'task-project-board-reply-schema.ts',
    before: `export const taskProjectMutationStatusSchema = z.looseObject({
  ok: optionalOk,
  error: optionalProjectError
})`,
    after: `export const taskProjectMutationStatusSchema = z.unknown()`
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
  // Decodes the reply envelope instead of the accepted snapshot, so the Home card publishes nothing
  // where a host answered.
  'home-accounts-envelope': {
    file: 'mobile-home-host-requests.ts',
    before: 'const snapshot = decodeAccountsSnapshot(accounts.value)',
    after: 'const snapshot = decodeAccountsSnapshot(reply)'
  },
  // Reads the push test result one level above the envelope, so an accepted test reports failure.
  'push-test-envelope': {
    file: 'notification-display-test.tsx',
    before: 'const result = delivered.value as MobilePushTestResult',
    after: 'const result = reply as unknown as MobilePushTestResult'
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
  // Keeps the composed draft cleared after a send the runtime refused, so the text the user typed
  // is gone and only a retype recovers it. Anchored on the branch that reads the send verdict, not
  // on the send, so the step-4 migration of this file does not move it.
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
        data: { pr, details: null, checks: [], checksError: checksOutcome.error }
      }`,
    after: '      return failureState(checksOutcome.error)'
  },
  // Sends the presence-lock `client` member whether or not this phone holds a device token, so a
  // tokenless phone claims the floor under an empty id instead of asking for the mode alone.
  'display-mode-unconditional-client': {
    file: 'use-mobile-session-terminal-stream-display.ts',
    before: `          ...(deviceTokenRef.current
            ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
            : {}),`,
    after: `          client: { id: deviceTokenRef.current, type: 'mobile' as const },`
  },
  // Forwards the viewport cell on every `auto` toggle, including before any surface has measured
  // one, so the host is told to drive at a null size rather than at the dims it already stored.
  'display-mode-unmeasured-viewport': {
    file: 'use-mobile-session-terminal-stream-display.ts',
    before: `          ...(viewportRef.current && next === 'auto' ? { viewport: viewportRef.current } : {})`,
    after: `          ...(next === 'auto' ? { viewport: viewportRef.current } : {})`
  },
  // Puts the active tab on the wire as `null` rather than omitting the member, so a create on a
  // fresh session or after the last tab closed asks the host to insert after a tab that is not
  // there. Invisible to any scenario whose session already has an active tab.
  'create-after-tab-id-null': {
    file: 'use-mobile-session-terminal-create-actions.ts',
    before: '        afterTabId: activeSessionTabId ?? undefined,',
    after: '        afterTabId: activeSessionTabId,'
  },
  // Swaps the two quick-command members, so a saved shell command arrives as an agent prompt and an
  // agent prompt arrives as a startup command. Invisible to any scenario that fills neither.
  'create-quick-command-keys': {
    file: 'use-mobile-session-terminal-create-actions.ts',
    before: `        ...(options?.startupCommand ? { command: options.startupCommand } : {}),
        ...(options?.startupCommandDelivery
          ? { startupCommandDelivery: options.startupCommandDelivery }
          : {}),
        ...(options?.agentPrompt ? { agentPrompt: options.agentPrompt } : {}),`,
    after: `        ...(options?.startupCommand ? { agentPrompt: options.startupCommand } : {}),
        ...(options?.startupCommandDelivery
          ? { startupCommandDelivery: options.startupCommandDelivery }
          : {}),
        ...(options?.agentPrompt ? { command: options.agentPrompt } : {}),`
  },
  // Drops the in-flight guard, so a second tap while the host is still answering opens a second
  // terminal the user never asked for. Invisible to any scenario that taps once.
  'create-second-tap-in-flight': {
    file: 'use-mobile-session-terminal-create-actions.ts',
    before: '    if (!client || creatingTerminalRef.current) {',
    after: '    if (!client) {'
  },
  // Lets a refused tab load reject the startup sequence, so neither the terminal load behind it nor
  // the two refresh timers it arms ever run and the route sits on "Loading terminals" with no
  // second chance. The activation timer is not among them: it needs `created === '1'`, which the
  // closing scenario leaves unset, so what kills this mutant is the missing fetches alone.
  'startup-tab-load-rejects-sequence': {
    file: 'use-mobile-session-startup.ts',
    before: '      await ensureSessionTabs().catch(() => null)',
    after: '      await ensureSessionTabs()'
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
