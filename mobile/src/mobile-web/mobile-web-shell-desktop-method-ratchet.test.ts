import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: the APK is the long-lived artifact. Every desktop method the shell names is a wire shape a
// page change cannot alter without an APK release, so the set is pinned and may only shrink. New
// page-to-desktop traffic rides `workspace.hostRequest` / `hostSubscribe` untouched by the shell.
const SHELL_DIR = resolve(__dirname)

/** The shell's own duties: minting worktree handles, resolving a tab for a terminal stream, the
 * terminal multiplex, device speech, and the one cancellable agent run it still owns. */
const PINNED_DESKTOP_METHODS: Record<string, readonly string[]> = {
  'mobile-web-commit-message-generation.ts': [
    'git.cancelGenerateCommitMessage',
    'git.generateCommitMessage'
  ],
  'mobile-web-host-navigation-route.ts': ['worktree.ps'],
  'mobile-web-native-chat-binding.ts': ['session.tabs.list'],
  'mobile-web-speech-session-rpc.ts': [
    'speech.dictation.cancel',
    'speech.dictation.finish',
    'speech.dictation.start'
  ],
  'mobile-web-terminal-device-input-authority.ts': ['repo.list'],
  'mobile-web-terminal-lease-streams.ts': ['terminal.subscribe'],
  'mobile-web-terminal-resolution.ts': ['session.tabs.list'],
  'mobile-web-terminal-streams.ts': ['terminal.multiplex'],
  'mobile-web-workspace-snapshot-pager.ts': ['worktree.ps']
}

const METHOD_CALL = /\b(?:sendRequest|subscribe)\(\s*'([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)'/g

function shellDesktopMethods(): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const name of readdirSync(SHELL_DIR).sort()) {
    if (!name.endsWith('.ts') || /\.test\.ts$|fixture/.test(name)) {
      continue
    }
    const methods = [...readFileSync(join(SHELL_DIR, name), 'utf8').matchAll(METHOD_CALL)]
      .map((match) => match[1]!)
      .filter((method) => !method.startsWith('mobileWeb.'))
    if (methods.length > 0) {
      found[name] = [...new Set(methods)].sort()
    }
  }
  return found
}

describe('mobile web shell desktop-method ratchet', () => {
  it('names no desktop method outside the pinned set', () => {
    expect(shellDesktopMethods()).toEqual(PINNED_DESKTOP_METHODS)
  })
})
