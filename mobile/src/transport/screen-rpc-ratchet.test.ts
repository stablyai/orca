import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const RPC_ENTRY_POINT =
  /\bsendRequest\b|\b\w*[Cc]lient(?:Ref)?(?:\.current)?\s*\??\.\s*subscribe\s*\(|\b\w*[Cc]lient\w*\s*\[\s*['"]subscribe['"]\s*\]|\.\s*subscribe\s*\(\s*['"`]/g

const MOBILE_ROOT = join(__dirname, '../..')

const NOT_SOURCE = /\.test\.tsx?$|test-support|\.generated\./

const INLINE_RPC_BY_FILE: Record<string, number> = {
  'app/h/[hostId]/accounts.tsx': 3,
  'app/terminal-settings.tsx': 3,
  'src/agent-history/MobileAgentSessionHistoryPanel.tsx': 7,
  'src/agent-history/use-mobile-agent-history-state.ts': 2,
  'src/browser/use-mobile-browser-commands.ts': 5,
  'src/browser/use-mobile-browser-request.ts': 1,
  'src/browser/use-mobile-browser-stream.ts': 1,
  'src/components/codex-reset-credit-capability.ts': 2,
  'src/components/codex-reset-credit.ts': 3,
  'src/components/use-new-workspace-create-submit.ts': 1,
  'src/components/use-new-workspace-execution-target.ts': 4,
  'src/components/use-new-workspace-repositories.ts': 1,
  'src/components/use-new-workspace-runtime-context.ts': 4,
  'src/components/use-new-workspace-setup-script.ts': 1,
  'src/dictation/mobile-dictation-setup.ts': 10,
  'src/files/MobileFileExplorerPanel.tsx': 2,
  'src/files/mobile-file-mutation-ownership.ts': 3,
  'src/files/mobile-file-preview-request.ts': 6,
  'src/files/mobile-file-tab-doc.ts': 4,
  'src/files/mobile-terminal-artifact-grant-refresh.ts': 2,
  'src/home/use-mobile-home-host-connections.ts': 1,
  'src/hooks/mobile-dictation-audio-chunk.ts': 1,
  'src/hooks/mobile-dictation-desktop-start.ts': 4,
  'src/hooks/use-mobile-dictation.ts': 4,
  'src/host-screen/host-screen-overlays.tsx': 1,
  'src/host-screen/use-host-repo-metadata.ts': 2,
  'src/host-screen/use-host-view-settings.ts': 2,
  'src/host-screen/use-host-worktree-actions.ts': 3,
  'src/notifications/mobile-notifications.ts': 4,
  'src/session/ai-vault-resume-launch.ts': 3,
  'src/session/ai-vault-resume-preparation.ts': 2,
  'src/session/github-pr-mutations.ts': 16,
  'src/session/github-pr-rpc.ts': 9,
  'src/session/mobile-clipboard-image.ts': 7,
  'src/session/mobile-diff-review-loaders.ts': 5,
  'src/session/mobile-file-tap-open.ts': 3,
  'src/session/mobile-image-attachment.ts': 2,
  'src/session/mobile-native-chat-image-attachment.ts': 1,
  'src/session/mobile-native-chat-image-send.ts': 2,
  'src/session/mobile-native-chat-send.ts': 3,
  'src/session/mobile-native-chat-session-option-persistence.ts': 1,
  'src/session/mobile-native-chat-stale-input.ts': 1,
  'src/session/mobile-new-tab-agent-loader.ts': 5,
  'src/session/mobile-session-tab-activation.ts': 3,
  'src/session/mobile-session-tabs-stream-health.ts': 1,
  'src/session/mobile-structured-agent-session-launch.ts': 3,
  'src/session/mobile-structured-agent-session-rpc.ts': 1,
  'src/session/mobile-terminal-stream-subscribe.ts': 2,
  'src/session/pr-ai-triage-launch.ts': 3,
  'src/session/use-live-worktree-name.ts': 2,
  'src/session/use-mobile-diff-review-comment-actions.ts': 1,
  'src/session/use-mobile-diff-review-git-actions.ts': 2,
  'src/session/use-mobile-diff-review-interactions.ts': 1,
  'src/session/use-mobile-diff-review-send-actions.ts': 3,
  'src/session/use-mobile-file-tap-handlers.ts': 1,
  'src/session/use-mobile-native-chat-file-search.ts': 2,
  'src/session/use-mobile-native-chat-readability.ts': 1,
  'src/session/use-mobile-native-chat-session.ts': 2,
  'src/session/use-mobile-native-chat-stop.ts': 1,
  'src/session/use-mobile-pr-actions.ts': 1,
  'src/session/use-mobile-pr-branch-context.ts': 2,
  'src/session/use-mobile-pr-comment-actions.ts': 1,
  'src/session/use-mobile-pr-title-action.ts': 1,
  'src/session/use-mobile-session-accessory-selection.ts': 1,
  'src/session/use-mobile-session-close-actions.ts': 3,
  'src/session/use-mobile-session-content-create-actions.ts': 4,
  'src/session/use-mobile-session-diff-comments.ts': 2,
  'src/session/use-mobile-session-document-readers.ts': 2,
  'src/session/use-mobile-session-markdown-actions.ts': 1,
  'src/session/use-mobile-session-startup.ts': 2,
  'src/session/use-mobile-session-tabs-reconciliation.ts': 1,
  'src/session/use-mobile-session-terminal-create-actions.ts': 2,
  'src/session/use-mobile-session-terminal-input.ts': 2,
  'src/session/use-mobile-session-terminal-list.ts': 1,
  'src/session/use-mobile-session-terminal-send-actions.ts': 2,
  'src/session/use-mobile-session-terminal-stream-display.ts': 1,
  'src/session/use-mobile-structured-agent-state.ts': 1,
  'src/session/use-mobile-terminal-paste.ts': 1,
  'src/session/use-pr-bot-author-overrides.ts': 1,
  'src/session/use-quick-commands.ts': 2,
  'src/source-control/MobileGitHistoryList.tsx': 1,
  'src/source-control/mobile-branch-base-ref.ts': 3,
  'src/source-control/mobile-commit-message-ai.ts': 4,
  'src/source-control/mobile-git-history.ts': 2,
  'src/source-control/mobile-hosted-review-create-intent-runner.ts': 1,
  'src/source-control/mobile-hosted-review-create-intent.ts': 3,
  'src/source-control/mobile-hosted-review-git-preparation.ts': 6,
  'src/source-control/mobile-hosted-review-remote-prerequisite.ts': 1,
  'src/source-control/mobile-hosted-review-service.ts': 8,
  'src/source-control/mobile-pr-link.ts': 8,
  'src/source-control/reveal-mobile-source-control-session-diff.ts': 2,
  'src/source-control/use-mobile-git-requests.ts': 1,
  'src/source-control/use-mobile-source-control-loaders.ts': 2,
  'src/source-control/use-mobile-source-control-openers.ts': 3,
  'src/tasks/composer-source-base-resolve.ts': 2,
  'src/tasks/mobile-tasks-filter-pickers.tsx': 1,
  'src/tasks/setup-hook-trust.ts': 1,
  'src/tasks/smart-source-paste-intent.ts': 4,
  'src/tasks/smart-source-search-requests.ts': 5,
  'src/tasks/use-mobile-tasks-client-settings-actions.tsx': 6,
  'src/tasks/use-mobile-tasks-github-check-file-actions.tsx': 5,
  'src/tasks/use-mobile-tasks-github-reply-merge-actions.tsx': 5,
  'src/tasks/use-mobile-tasks-gitlab-github-status-actions.tsx': 3,
  'src/tasks/use-mobile-tasks-hosted-comment-review-actions.tsx': 4,
  'src/tasks/use-mobile-tasks-hosted-metadata-actions.tsx': 2,
  'src/tasks/use-mobile-tasks-item-detail-loading.tsx': 4,
  'src/tasks/use-mobile-tasks-item-detail-metadata-effects.tsx': 2,
  'src/tasks/use-mobile-tasks-linear-item-actions.tsx': 3,
  'src/tasks/use-mobile-tasks-list-and-detail-effects.tsx': 2,
  'src/tasks/use-mobile-tasks-project-detail-loading.tsx': 1,
  'src/tasks/use-mobile-tasks-project-file-merge-actions.tsx': 4,
  'src/tasks/use-mobile-tasks-project-loading-actions.tsx': 4,
  'src/tasks/use-mobile-tasks-project-metadata-actions.tsx': 3,
  'src/tasks/use-mobile-tasks-project-metadata-loading.tsx': 3,
  'src/tasks/use-mobile-tasks-project-repository-resolution.tsx': 1,
  'src/tasks/use-mobile-tasks-project-review-check-actions.tsx': 4,
  'src/tasks/use-mobile-tasks-project-thread-reply-actions.tsx': 4,
  'src/tasks/use-mobile-tasks-project-workspace-comment-actions.tsx': 3,
  'src/tasks/use-mobile-tasks-provider-load-actions.tsx': 5,
  'src/tasks/use-mobile-tasks-route-and-item-state.tsx': 1,
  'src/tasks/use-mobile-tasks-runtime-hydration.tsx': 5,
  'src/tasks/use-mobile-tasks-task-create-actions.tsx': 3,
  'src/tasks/use-mobile-tasks-task-list-loading.tsx': 4,
  'src/tasks/use-mobile-tasks-task-pagination-actions.tsx': 1,
  'src/tasks/use-mobile-tasks-workspace-create-actions.tsx': 4,
  'src/tasks/use-mobile-tasks-workspace-source-effects.tsx': 2,
  'src/tasks/use-mobile-tasks-workspace-sparse-actions.tsx': 2,
  'src/tasks/use-mobile-tasks-workspace-ssh-state.tsx': 5,
  'src/tasks/worktree-create-capability.ts': 1,
  'src/tasks/worktree-create-retry.ts': 1,
  'src/terminal/mobile-terminal-query-reply.ts': 2,
  'src/terminal/terminal-live-accessory-raw-send.ts': 2,
  'src/terminal/terminal-viewport-refit.ts': 1,
  'src/terminal/worker-terminal-takeover-report.ts': 2,
  'src/transport/direct-rpc-client.ts': 3,
  'src/transport/host-status-gates.ts': 1,
  'src/transport/mobile-endpoint-supervisor-test-fakes.ts': 2,
  'src/transport/mobile-relay-credential-rotation.ts': 2,
  'src/transport/mobile-relay-direct-upgrade.ts': 2,
  'src/transport/mobile-relay-pairing-recovery.ts': 2,
  'src/transport/mobile-relay-physical-client.ts': 2,
  'src/transport/mobile-relay-rpc-session.ts': 1,
  'src/transport/mobile-relay-rpc-streams.ts': 2,
  'src/transport/mobile-runtime-capability-negotiation.ts': 4,
  'src/transport/pairing-candidate-race.ts': 1,
  'src/transport/pairing-relay-candidate.ts': 4,
  'src/transport/pre-profile-pairing-coordinator.ts': 2,
  'src/transport/request-single-flight.ts': 2,
  'src/transport/rpc-client-request-tracker.ts': 3,
  'src/transport/rpc-client.ts': 1,
  'src/transport/runtime-capability-probe.ts': 1,
  'src/transport/stable-logical-rpc-client.ts': 3,
  'src/worktree/host-worktree-refresh.ts': 1,
  'src/worktree/use-retired-worktree-names.ts': 1,
  'src/worktree/worktree-catalog-snapshot-client.ts': 1
}

const DELIBERATE_INLINE_CALLS: Record<string, string[]> = {
  // `terminal.close` — closing the terminal, not the tab; the tab adapter's close is a tab close.
  'src/session/use-mobile-session-close-actions.ts': ['terminal.close'],
  // Note creation has no operations counterpart.
  'src/session/use-mobile-session-content-create-actions.ts': ['files.createFile', 'files.open'],
  // The buffered submit; it needs the raw response to classify a partial write.
  'src/session/use-mobile-session-terminal-send-actions.ts': ['terminal.send'],
  // The composer's create builds different params and adds name-collision retry.
  'src/tasks/use-mobile-tasks-workspace-create-actions.tsx': ['worktree.create']
}

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry)
      if (statSync(absolute).isDirectory()) {
        walk(absolute)
        continue
      }
      const path = relative(MOBILE_ROOT, absolute).split('\\').join('/')
      if (/\.tsx?$/.test(entry) && !NOT_SOURCE.test(path)) {
        found.push(path)
      }
    }
  }
  walk(join(MOBILE_ROOT, 'src'))
  walk(join(MOBILE_ROOT, 'app'))
  return found.sort()
}

const read = (path: string): string => readFileSync(join(MOBILE_ROOT, path), 'utf8')
const countEntryPoints = (source: string): number => (source.match(RPC_ENTRY_POINT) ?? []).length

describe('screen RPC ratchet', () => {
  it('pins which RPCs are left inline on purpose, by name not by count', () => {
    const actual = Object.fromEntries(
      Object.keys(DELIBERATE_INLINE_CALLS).map((path) => [
        path,
        [...read(path).matchAll(/sendRequest\(\s*'([\w.]+)'/g)].map((match) => match[1]).sort()
      ])
    )
    const expected = Object.fromEntries(
      Object.entries(DELIBERATE_INLINE_CALLS).map(([path, methods]) => [path, [...methods].sort()])
    )
    for (const [path, methods] of Object.entries(expected)) {
      expect(actual[path]).toEqual(expect.arrayContaining(methods))
    }
  })

  it('pins every remaining inline RPC site so none can be added unnoticed', () => {
    const actual: Record<string, number> = {}
    for (const path of sourceFiles()) {
      const count = countEntryPoints(read(path))
      if (count > 0) {
        actual[path] = count
      }
    }
    expect(actual).toEqual(INLINE_RPC_BY_FILE)
  })
})
