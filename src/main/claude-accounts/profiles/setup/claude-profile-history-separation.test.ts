import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shareClaudeProfileHistory } from './claude-profile-history'
import { separateClaudeProfileHistory } from './claude-profile-history-separation'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'orca-history-separation-'))
  const userHome = join(root, 'user')
  const shared = join(userHome, '.claude')
  const profileHome = join(root, 'claude-profiles', 'axion', 'home')
  mkdirSync(join(shared, 'projects', 'bucket'), { recursive: true })
  mkdirSync(profileHome, { recursive: true })
  writeFileSync(join(shared, 'projects', 'bucket', 'personal.jsonl'), 'personal\n')
  writeFileSync(join(shared, 'history.jsonl'), '{"display":"personal"}\n')
  return { userHome, shared, profileHome }
}

describe('separateClaudeProfileHistory', () => {
  it('stops sharing without touching the shared history, and sharing again merges back', async () => {
    const { userHome, shared, profileHome } = setup()
    await shareClaudeProfileHistory({ profileHome, userHome })
    expect(lstatSync(join(profileHome, 'projects')).isSymbolicLink()).toBe(true)

    const report = await separateClaudeProfileHistory({ profileHome, userHome })
    expect(report.warnings).toEqual([])
    // The account's folders are its own now, and start empty.
    expect(lstatSync(join(profileHome, 'projects')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(profileHome, 'projects', 'bucket', 'personal.jsonl'))).toBe(false)
    expect(existsSync(join(profileHome, 'history.jsonl'))).toBe(false)
    // What was shared stays where it was.
    expect(readFileSync(join(shared, 'projects', 'bucket', 'personal.jsonl'), 'utf8')).toBe(
      'personal\n'
    )
    expect(readFileSync(join(shared, 'history.jsonl'), 'utf8')).toBe('{"display":"personal"}\n')

    // The account's own conversations never reach the shared history while separated.
    mkdirSync(join(profileHome, 'projects', 'bucket'), { recursive: true })
    writeFileSync(join(profileHome, 'projects', 'bucket', 'axion.jsonl'), 'axion\n')
    expect(existsSync(join(shared, 'projects', 'bucket', 'axion.jsonl'))).toBe(false)

    // Separating again changes nothing.
    await separateClaudeProfileHistory({ profileHome, userHome })
    expect(readFileSync(join(profileHome, 'projects', 'bucket', 'axion.jsonl'), 'utf8')).toBe(
      'axion\n'
    )

    // Sharing again keeps both accounts' conversations.
    await shareClaudeProfileHistory({ profileHome, userHome })
    expect(readFileSync(join(shared, 'projects', 'bucket', 'axion.jsonl'), 'utf8')).toBe('axion\n')
    expect(readFileSync(join(shared, 'projects', 'bucket', 'personal.jsonl'), 'utf8')).toBe(
      'personal\n'
    )
  })

  // Windows links prompt history with a hardlink, which no longer shares once the file is gone.
  it.skipIf(process.platform === 'win32')(
    'drops a prompt history link whose shared file was deleted, so it cannot share again',
    async () => {
      const { userHome, shared, profileHome } = setup()
      symlinkSync(join(shared, 'history.jsonl'), join(profileHome, 'history.jsonl'))
      rmSync(join(shared, 'history.jsonl'))

      await separateClaudeProfileHistory({ profileHome, userHome })
      writeFileSync(join(shared, 'history.jsonl'), '{"display":"personal"}\n')
      expect(existsSync(join(profileHome, 'history.jsonl'))).toBe(false)
    }
  )
})
