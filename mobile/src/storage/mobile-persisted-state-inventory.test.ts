import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const storageImportPattern =
  /from ['"](?:@react-native-async-storage\/async-storage|expo-secure-store)['"]/

const EXPECTED_PERSISTED_STATE_SOURCES = [
  'mobile/src/cache/home-snapshot-cache.ts',
  'mobile/src/home/use-mobile-home-data.ts',
  'mobile/src/mobile-web/mobile-web-cold-resume-route.ts',
  'mobile/src/notifications/notification-reconnect-catchup.ts',
  'mobile/src/session/session-last-visited-worktree.ts',
  'mobile/src/storage/codex-reset-attempt-journal.ts',
  'mobile/src/storage/mobile-session-chat-drafts.ts',
  'mobile/src/storage/mobile-session-chat-pending-deliveries.ts',
  'mobile/src/storage/mobile-session-markdown-drafts.ts',
  'mobile/src/storage/preferences.ts',
  'mobile/src/storage/session-view-preferences.ts',
  'mobile/src/storage/terminal-custom-key-storage.ts',
  'mobile/src/terminal/terminal-accessory-layout.ts',
  'mobile/src/transport/host-app-version-store.ts',
  'mobile/src/transport/host-credential-cleanup.ts',
  'mobile/src/transport/host-device-token-store.ts',
  'mobile/src/transport/host-metadata-store.ts',
  'mobile/src/transport/mobile-relay-host-overlay-store.ts',
  'mobile/src/transport/mobile-relay-pairing-journal-store.ts',
  'mobile/src/transport/pairing-keychain.ts',
  'mobile/src/transport/persisted-connection-log-store.ts',
  'mobile/src/worktree/use-last-visited-worktree-repo.ts'
]

describe('mobile persisted state inventory', () => {
  it('requires every JavaScript persistence boundary to stay inventoried', () => {
    expect(
      ['mobile/app', 'mobile/src']
        .flatMap((root) => persistenceSources(join(repositoryRoot, root)))
        .sort()
    ).toEqual(EXPECTED_PERSISTED_STATE_SOURCES)
  })
})

function persistenceSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      return persistenceSources(path)
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name) || entry.name.includes('.test.')) {
      return []
    }
    return storageImportPattern.test(readFileSync(path, 'utf8'))
      ? [relative(repositoryRoot, path).split(sep).join('/')]
      : []
  })
}
