import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../shared/claude-profile-routing'
import { readClaudeChatKeybindings } from './claude-chat-keybindings'

const ENV_KEYS = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
] as const
type ClaudeEnv = Partial<Record<(typeof ENV_KEYS)[number], string>>

const savedEnv: ClaudeEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
let tempRoots: string[] = []

function setEnv(env: ClaudeEnv): void {
  for (const key of ENV_KEYS) {
    const value = env[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-keybindings-'))
  tempRoots.push(root)
  return root
}

async function writeKeybindings(dir: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'keybindings.json'), content)
}

afterEach(async () => {
  setEnv(savedEnv)
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('readClaudeChatKeybindings', () => {
  it('returns the keybindings.json under ~/.claude', async () => {
    const root = await tempRoot()
    const content = JSON.stringify({
      bindings: [{ context: 'Chat', bindings: { 'meta+enter': 'chat:submit' } }]
    })
    await writeKeybindings(join(root, '.claude'), content)
    setEnv({ HOME: root })
    expect(await readClaudeChatKeybindings()).toBe(content)
  })

  it('returns null when the file is absent (default installs)', async () => {
    setEnv({ HOME: await tempRoot() })
    expect(await readClaudeChatKeybindings()).toBeNull()
  })

  it('honors CLAUDE_CONFIG_DIR over ~/.claude', async () => {
    const root = await tempRoot()
    const configDir = join(root, 'pinned-claude-home')
    await writeKeybindings(configDir, 'PINNED')
    setEnv({ HOME: root, CLAUDE_CONFIG_DIR: configDir })
    expect(await readClaudeChatKeybindings()).toBe('PINNED')
  })

  it("reads the user's own folder when CLAUDE_CONFIG_DIR is a profile home Orca injected", async () => {
    const root = await tempRoot()
    const profileHome = join(root, 'profile-home')
    const userConfigDir = join(root, 'user-claude')
    await writeKeybindings(profileHome, 'PROFILE')
    await writeKeybindings(userConfigDir, 'USER')
    setEnv({
      HOME: root,
      CLAUDE_CONFIG_DIR: profileHome,
      [CLAUDE_INJECTED_CONFIG_DIR_ENV]: profileHome,
      [CLAUDE_USER_CONFIG_DIR_ENV]: userConfigDir
    })
    expect(await readClaudeChatKeybindings()).toBe('USER')
  })
})
