// A teammate's Home has one title owner, the record store's reads (agent-session-record-home-names.ts).
// This census fails when code elsewhere works one out, or shows a raw record's name.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const NAME_MODULE = 'src/main/runtime/agent-session/records/agent-session-record-home-names.ts'

/** Source files (tests and locales left out) whose text matches `pattern` (extended regex). */
function using(pattern: string): string[] {
  try {
    return execFileSync(
      'git',
      [
        'grep',
        '-lE',
        pattern,
        '--',
        'src',
        'mobile/src',
        ':!*.test.*',
        ':!*.test-*',
        ':!**/locales/**'
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
      .split('\n')
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .sort()
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if (error instanceof Error && 'status' in error && error.status === 1) {
      return []
    }
    throw error
  }
}

describe('teammate Home title census', () => {
  it('works out a teammate Home’s title only in the name module', () => {
    // bot-home-of.ts holds the shared wording the name module uses.
    expect(using('(botHomeName|teammateHomeName|withTeammateHomeName)\\(')).toEqual(
      [NAME_MODULE, 'src/shared/bots/bot-home-of.ts'].sort()
    )
  })

  it('labels whose Home a chat is only where the label is about the person, not the chat’s title', () => {
    expect(using("'bots\\.chats\\.personHome'")).toEqual([
      // The chats tree's origin icon tooltip ("<person>’s Home") and the Home banner's note.
      'src/renderer/src/components/bots/BotChatOriginIcon.tsx',
      'src/renderer/src/components/native-chat/pane/actions/NativeChatPaneHeader.tsx'
    ])
  })

  it('never shows the name off a raw (writable) record', () => {
    expect(
      using('(requireWritableRecord|selectWritableRecord)\\(').filter((file) =>
        /\.conversationName\b/.test(readFileSync(file, 'utf8'))
      )
    ).toEqual([])
  })
})
