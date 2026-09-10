import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MOBILE_SESSION_ROUTE_SOURCE_FILES = [
  '../../app/h/[hostId]/session/[worktreeId].tsx',
  './use-mobile-session-controller.ts',
  './use-mobile-session-foundation.ts',
  './use-mobile-session-screen-state.ts',
  './use-mobile-session-terminal-runtime.ts',
  './use-mobile-session-feedback-capabilities.ts',
  './use-mobile-session-native-chat-dictation.ts',
  './use-mobile-session-terminal-subscription-foundation.ts',
  './use-mobile-session-terminal-subscription.ts',
  './use-mobile-session-terminal-stream-display.ts',
  './use-mobile-session-terminal-list.ts',
  './use-mobile-session-tab-application.ts',
  './use-mobile-session-document-readers.ts',
  './use-mobile-session-diff-comments.ts',
  './use-mobile-session-markdown-actions.ts',
  './use-mobile-session-tab-reconciliation.ts',
  './use-mobile-session-lifecycle.ts',
  './use-mobile-session-keyboard-state.ts',
  './use-mobile-session-startup.ts',
  './use-mobile-session-preference-focus.ts',
  './use-mobile-session-tab-switching.ts',
  './use-mobile-session-terminal-webview.ts',
  './use-mobile-session-terminal-send-actions.ts',
  './use-mobile-session-file-actions.ts',
  './use-mobile-session-terminal-input.ts',
  './use-mobile-session-accessory-selection.ts',
  './use-mobile-session-attachments.ts',
  './use-mobile-session-terminal-create-actions.ts',
  './use-mobile-session-content-create-actions.ts',
  './use-mobile-session-close-actions.ts',
  './use-mobile-session-bulk-close.ts',
  './use-mobile-session-presentation.ts',
  './use-mobile-session-panel-route-actions.tsx',
  './MobileSessionMarkdownReader.tsx',
  './MobileSessionDiffLineRow.tsx',
  './MobileSessionFileReader.tsx',
  './MobileSessionSurface.tsx',
  './MobileSessionHeader.tsx',
  './MobileSessionContentRow.tsx',
  './MobileSessionActiveContent.tsx',
  './MobileSessionCommandDock.tsx',
  './MobileSessionSheets.tsx',
  // The adapters the route's RPCs moved into. Without them the runtime strings and identity
  // fields that left the hooks would leave this family's scope entirely.
  './native-host-session-browser-operations.ts',
  './native-host-session-file-operations.ts',
  './native-host-session-markdown-operations.ts',
  './native-host-session-native-chat-operations.ts',
  './native-host-session-quick-command-operations.ts',
  './native-host-session-tab-operations.ts',
  './native-host-session-terminal-file-operations.ts',
  './native-host-session-terminal-operations.ts'
] as const

export function readMobileSessionRouteSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

export function readMobileSessionRouteSourceFamily(
  relativePaths: readonly string[] = MOBILE_SESSION_ROUTE_SOURCE_FILES
): string {
  return relativePaths
    .map(
      (relativePath) => `// Source: ${relativePath}\n${readMobileSessionRouteSource(relativePath)}`
    )
    .join('\n')
}
