/**
 * Every file that still reaches mobile's raw RPC request port, held as data.
 *
 * A reference is any direct reach for the port: a `.sendRequest` access or declaration, a
 * `'sendRequest'` selector such as `Pick<RpcClient, 'sendRequest'>`, a call to the coalescing
 * second sender `sendSingleFlightRequest`, or an import of unvalidated-rpc-request-port.ts.
 * The count is per file and is a ceiling, not a target: unvalidated-rpc-request-port-boundary.test.ts
 * fails on a file that is not listed, on a listed file that no longer reaches the port, and on a
 * listed file whose count went up. Both lists only shrink.
 *
 * The owners are permanent — they implement, route or validate the port. The pending list is the
 * step-4 migration backlog and shares one reason, stated once here instead of 144 times:
 * the call site predates the typed contract and still picks its own method string, its own
 * acceptance rule and its own decoding. Replacing one with an RpcOperation deletes its line.
 */
export type UnvalidatedRpcRequestPortEntry = {
  readonly file: string
  readonly references: number
}

/** Modules whose job is the port. These do not shrink to zero. */
export const UNVALIDATED_RPC_REQUEST_PORT_OWNERS: readonly UnvalidatedRpcRequestPortEntry[] = [
  // Implements the port over the device-to-host websocket.
  { file: 'src/transport/direct-rpc-client.ts', references: 3 },
  // Fakes the port for the supervisor suites; a non-test file only because tsconfig excludes tests.
  { file: 'src/transport/mobile-endpoint-supervisor-test-fakes.ts', references: 2 },
  // Implements the port over a relay channel.
  { file: 'src/transport/mobile-relay-physical-client.ts', references: 2 },
  // Supplies the port for one relay session.
  { file: 'src/transport/mobile-relay-rpc-session.ts', references: 1 },
  // A second raw sender: string method in, unread envelope out. Its callers are fenced too.
  { file: 'src/transport/request-single-flight.ts', references: 3 },
  // Owns connect-wait, timeout and replay bookkeeping for every raw request.
  { file: 'src/transport/rpc-client-request-tracker.ts', references: 1 },
  // Composes the port into RpcClient, which is why every holder of a client still carries it.
  { file: 'src/transport/rpc-client.ts', references: 2 },
  // The typed boundary itself — the one module that turns a reply into a declared type.
  { file: 'src/transport/rpc-operation.ts', references: 2 },
  // Forwards the port across a physical-client cutover.
  { file: 'src/transport/stable-logical-rpc-client.ts', references: 2 }
]

/** Call sites awaiting migration to a typed operation. Grouped by the feature area that owns them. */
export const UNVALIDATED_RPC_REQUEST_PORT_PENDING: readonly UnvalidatedRpcRequestPortEntry[] = [
  // app/h/[hostId]/ — Expo route screens
  { file: 'app/h/[hostId]/accounts.tsx', references: 2 },

  // app/ — Expo route screens
  { file: 'app/terminal-settings.tsx', references: 3 },

  // src/agent-history/ — agent history loads
  { file: 'src/agent-history/MobileAgentSessionHistoryPanel.tsx', references: 7 },
  { file: 'src/agent-history/use-mobile-agent-history-state.ts', references: 2 },

  // src/browser/ — hosted browser control
  { file: 'src/browser/use-mobile-browser-commands.ts', references: 5 },
  { file: 'src/browser/use-mobile-browser-request.ts', references: 1 },

  // src/components/ — shared widgets that fetch their own data
  { file: 'src/components/codex-reset-credit-capability.ts', references: 2 },
  { file: 'src/components/codex-reset-credit.ts', references: 3 },
  { file: 'src/components/use-new-workspace-create-submit.ts', references: 1 },
  { file: 'src/components/use-new-workspace-execution-target.ts', references: 4 },
  { file: 'src/components/use-new-workspace-repositories.ts', references: 1 },
  { file: 'src/components/use-new-workspace-runtime-context.ts', references: 4 },
  { file: 'src/components/use-new-workspace-setup-script.ts', references: 1 },

  // src/dictation/ — dictation session control
  { file: 'src/dictation/mobile-dictation-setup.ts', references: 10 },

  // src/files/ — file read, write and preview
  { file: 'src/files/mobile-file-mutation-ownership.ts', references: 3 },
  { file: 'src/files/mobile-file-preview-request.ts', references: 6 },
  { file: 'src/files/mobile-file-tab-doc.ts', references: 4 },
  { file: 'src/files/mobile-terminal-artifact-grant-refresh.ts', references: 2 },
  { file: 'src/files/MobileFileExplorerPanel.tsx', references: 2 },

  // src/home/ — home screen host reads
  { file: 'src/home/mobile-home-host-requests.ts', references: 6 },

  // src/hooks/ — cross-screen data hooks
  { file: 'src/hooks/mobile-dictation-audio-chunk.ts', references: 1 },
  { file: 'src/hooks/mobile-dictation-desktop-start.ts', references: 4 },
  { file: 'src/hooks/use-mobile-dictation.ts', references: 4 },

  // src/host-screen/ — host screen catalog and actions
  { file: 'src/host-screen/host-screen-overlays.tsx', references: 1 },
  { file: 'src/host-screen/use-host-repo-metadata.ts', references: 2 },
  { file: 'src/host-screen/use-host-view-settings.ts', references: 2 },
  { file: 'src/host-screen/use-host-worktree-actions.ts', references: 3 },

  // src/notifications/ — push registration and delivery
  { file: 'src/notifications/mobile-notifications.ts', references: 1 },
  { file: 'src/notifications/push-dismissal-reconciliation.ts', references: 2 },
  { file: 'src/notifications/push-registration.ts', references: 3 },

  // src/session/ — session screen: chat, diff review, PR actions, tabs
  { file: 'src/session/ai-vault-resume-launch.ts', references: 3 },
  { file: 'src/session/ai-vault-resume-preparation.ts', references: 2 },
  { file: 'src/session/github-pr-mutations.ts', references: 16 },
  { file: 'src/session/github-pr-rpc.ts', references: 9 },
  { file: 'src/session/mobile-clipboard-image.ts', references: 7 },
  { file: 'src/session/mobile-diff-review-loaders.ts', references: 5 },
  { file: 'src/session/mobile-file-tap-open.ts', references: 3 },
  { file: 'src/session/mobile-image-attachment.ts', references: 2 },
  { file: 'src/session/mobile-native-chat-image-attachment.ts', references: 1 },
  { file: 'src/session/mobile-native-chat-image-send.ts', references: 2 },
  { file: 'src/session/mobile-native-chat-send.ts', references: 2 },
  { file: 'src/session/mobile-native-chat-session-option-persistence.ts', references: 1 },
  { file: 'src/session/mobile-native-chat-stale-input.ts', references: 1 },
  { file: 'src/session/mobile-new-tab-agent-loader.ts', references: 5 },
  { file: 'src/session/mobile-session-tab-activation.ts', references: 3 },
  { file: 'src/session/mobile-session-tabs-stream-health.ts', references: 1 },
  { file: 'src/session/mobile-structured-agent-session-launch.ts', references: 3 },
  { file: 'src/session/mobile-structured-agent-session-rpc.ts', references: 1 },
  { file: 'src/session/pr-ai-triage-launch.ts', references: 3 },
  { file: 'src/session/use-live-worktree-name.ts', references: 1 },
  { file: 'src/session/use-mobile-diff-review-comment-actions.ts', references: 1 },
  { file: 'src/session/use-mobile-diff-review-git-actions.ts', references: 2 },
  { file: 'src/session/use-mobile-diff-review-interactions.ts', references: 1 },
  { file: 'src/session/use-mobile-diff-review-send-actions.ts', references: 3 },
  { file: 'src/session/use-mobile-file-tap-handlers.ts', references: 1 },
  { file: 'src/session/use-mobile-native-chat-file-search.ts', references: 2 },
  { file: 'src/session/use-mobile-native-chat-readability.ts', references: 1 },
  { file: 'src/session/use-mobile-native-chat-session.ts', references: 1 },
  { file: 'src/session/use-mobile-native-chat-stop.ts', references: 1 },
  { file: 'src/session/use-mobile-pr-actions.ts', references: 1 },
  { file: 'src/session/use-mobile-pr-branch-context.ts', references: 2 },
  { file: 'src/session/use-mobile-pr-comment-actions.ts', references: 1 },
  { file: 'src/session/use-mobile-pr-title-action.ts', references: 1 },
  { file: 'src/session/use-mobile-session-accessory-selection.ts', references: 1 },
  { file: 'src/session/use-mobile-session-close-actions.ts', references: 3 },
  { file: 'src/session/use-mobile-session-content-create-actions.ts', references: 4 },
  { file: 'src/session/use-mobile-session-diff-comments.ts', references: 2 },
  { file: 'src/session/use-mobile-session-document-readers.ts', references: 2 },
  { file: 'src/session/use-mobile-session-markdown-actions.ts', references: 1 },
  { file: 'src/session/use-mobile-session-startup.ts', references: 2 },
  { file: 'src/session/use-mobile-session-terminal-create-actions.ts', references: 2 },
  { file: 'src/session/use-mobile-session-terminal-input.ts', references: 2 },
  { file: 'src/session/use-mobile-session-terminal-list.ts', references: 1 },
  { file: 'src/session/use-mobile-session-terminal-send-actions.ts', references: 2 },
  { file: 'src/session/use-mobile-session-terminal-stream-display.ts', references: 1 },
  { file: 'src/session/use-mobile-terminal-paste.ts', references: 1 },
  { file: 'src/session/use-pr-bot-author-overrides.ts', references: 1 },
  { file: 'src/session/use-quick-commands.ts', references: 2 },

  // src/settings/ — settings screen actions
  { file: 'src/settings/native-voice-settings-operations.ts', references: 1 },

  // src/settings/ — notification display probe
  { file: 'src/settings/notification-display-test.tsx', references: 1 },

  // src/source-control/ — source control: review, commit, branch
  { file: 'src/source-control/mobile-branch-base-ref.ts', references: 3 },
  { file: 'src/source-control/mobile-commit-message-ai.ts', references: 4 },
  { file: 'src/source-control/mobile-git-history.ts', references: 2 },
  { file: 'src/source-control/mobile-hosted-review-create-intent-runner.ts', references: 1 },
  { file: 'src/source-control/mobile-hosted-review-create-intent.ts', references: 3 },
  { file: 'src/source-control/mobile-hosted-review-git-preparation.ts', references: 6 },
  { file: 'src/source-control/mobile-hosted-review-remote-prerequisite.ts', references: 1 },
  { file: 'src/source-control/mobile-hosted-review-service.ts', references: 8 },
  { file: 'src/source-control/mobile-pr-link.ts', references: 8 },
  { file: 'src/source-control/MobileGitHistoryList.tsx', references: 1 },
  { file: 'src/source-control/reveal-mobile-source-control-session-diff.ts', references: 2 },
  { file: 'src/source-control/use-mobile-git-requests.ts', references: 1 },
  { file: 'src/source-control/use-mobile-source-control-loaders.ts', references: 2 },
  { file: 'src/source-control/use-mobile-source-control-openers.ts', references: 3 },

  // src/tasks/ — task lists, filters and mutations
  { file: 'src/tasks/composer-source-base-resolve.ts', references: 2 },
  { file: 'src/tasks/mobile-tasks-filter-pickers.tsx', references: 1 },
  { file: 'src/tasks/mobile-tasks-source-family.test-support.ts', references: 1 },
  { file: 'src/tasks/setup-hook-trust.ts', references: 1 },
  { file: 'src/tasks/smart-source-paste-intent.ts', references: 4 },
  { file: 'src/tasks/smart-source-search-requests.ts', references: 5 },
  { file: 'src/tasks/use-mobile-tasks-client-settings-actions.tsx', references: 6 },
  { file: 'src/tasks/use-mobile-tasks-github-check-file-actions.tsx', references: 5 },
  { file: 'src/tasks/use-mobile-tasks-github-reply-merge-actions.tsx', references: 5 },
  { file: 'src/tasks/use-mobile-tasks-gitlab-github-status-actions.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-hosted-comment-review-actions.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-hosted-metadata-actions.tsx', references: 2 },
  { file: 'src/tasks/use-mobile-tasks-item-detail-loading.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-item-detail-metadata-effects.tsx', references: 2 },
  { file: 'src/tasks/use-mobile-tasks-linear-item-actions.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-list-and-detail-effects.tsx', references: 2 },
  { file: 'src/tasks/use-mobile-tasks-project-detail-loading.tsx', references: 1 },
  { file: 'src/tasks/use-mobile-tasks-project-file-merge-actions.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-project-loading-actions.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-project-metadata-actions.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-project-metadata-loading.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-project-repository-resolution.tsx', references: 1 },
  { file: 'src/tasks/use-mobile-tasks-project-review-check-actions.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-project-thread-reply-actions.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-project-workspace-comment-actions.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-provider-load-actions.tsx', references: 5 },
  { file: 'src/tasks/use-mobile-tasks-route-and-item-state.tsx', references: 1 },
  { file: 'src/tasks/use-mobile-tasks-runtime-hydration.tsx', references: 5 },
  { file: 'src/tasks/use-mobile-tasks-task-create-actions.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-task-list-loading.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-task-pagination-actions.tsx', references: 1 },
  { file: 'src/tasks/use-mobile-tasks-workspace-create-actions.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-workspace-source-effects.tsx', references: 2 },
  { file: 'src/tasks/use-mobile-tasks-workspace-sparse-actions.tsx', references: 2 },
  { file: 'src/tasks/use-mobile-tasks-workspace-ssh-state.tsx', references: 5 },
  { file: 'src/tasks/worktree-create-capability.ts', references: 1 },
  { file: 'src/tasks/worktree-create-retry.ts', references: 1 },

  // src/terminal/ — terminal input, viewport and queries
  { file: 'src/terminal/mobile-terminal-query-reply.ts', references: 2 },
  { file: 'src/terminal/terminal-live-accessory-raw-send.ts', references: 2 },
  { file: 'src/terminal/terminal-viewport-refit.ts', references: 1 },
  { file: 'src/terminal/worker-terminal-takeover-report.ts', references: 2 },

  // src/transport/ — pairing, endpoint probing and capability reads
  { file: 'src/transport/host-status-gates.ts', references: 1 },
  { file: 'src/transport/mobile-relay-credential-rotation.ts', references: 2 },
  { file: 'src/transport/mobile-relay-direct-upgrade.ts', references: 2 },
  { file: 'src/transport/mobile-relay-pairing-recovery.ts', references: 2 },
  { file: 'src/transport/mobile-runtime-capability-negotiation.ts', references: 2 },
  { file: 'src/transport/pairing-candidate-race.ts', references: 1 },
  { file: 'src/transport/pairing-relay-candidate.ts', references: 4 },
  { file: 'src/transport/pre-profile-pairing-coordinator.ts', references: 2 },
  { file: 'src/transport/runtime-capability-probe.ts', references: 2 },

  // src/worktree/ — worktree activation and resume
  { file: 'src/worktree/home-host-worktree-fetch.ts', references: 2 },
  { file: 'src/worktree/use-retired-worktree-names.ts', references: 1 },
  { file: 'src/worktree/worktree-catalog-snapshot-client.ts', references: 1 }
]
