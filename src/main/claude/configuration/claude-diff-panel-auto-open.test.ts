import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { claudeDiffPanelMayAutoOpen, claudeDiffPanelStorePath } from './claude-diff-panel-auto-open'

let home: string
let configDir: string

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

function mayAutoOpen(
  cols: number | null,
  options: { version?: string | null; configDirEnv?: string } = {}
): Promise<boolean> {
  return claudeDiffPanelMayAutoOpen({
    configDirEnv: options.configDirEnv,
    version: 'version' in options ? (options.version ?? null) : '2.1.301',
    cols,
    home,
    platform: 'linux'
  })
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'orca-claude-diff-panel-'))
  configDir = join(home, '.claude')
  await mkdir(configDir)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('claudeDiffPanelMayAutoOpen', () => {
  it('never opens once the user closed it, in the store or the older global config', async () => {
    await writeJson(claudeDiffPanelStorePath(configDir), { open: false })
    expect(await mayAutoOpen(200)).toBe(false)

    await rm(claudeDiffPanelStorePath(configDir))
    await writeJson(join(home, '.claude.json'), { diffSidebarOpen: false })
    expect(await mayAutoOpen(200)).toBe(false)

    await writeJson(join(home, '.claude.json'), { diffSidebarOpen: true })
    await writeJson(join(configDir, '.config.json'), { diffSidebarOpen: false })
    expect(await mayAutoOpen(200)).toBe(false)
  })

  it('reads an explicit CLAUDE_CONFIG_DIR, whose global config sits inside it', async () => {
    const account = join(home, 'accounts', 'a')
    await writeJson(join(account, '.claude.json'), { diffSidebarOpen: false })
    expect(await mayAutoOpen(200, { configDirEnv: account })).toBe(false)
    await writeJson(join(home, '.claude.json'), { diffSidebarOpen: false })
    await rm(join(account, '.claude.json'))
    expect(await mayAutoOpen(200, { configDirEnv: account })).toBe(true)
  })

  it('lets the store win over the global config, and ignores malformed files', async () => {
    await writeJson(join(home, '.claude.json'), { diffSidebarOpen: false })
    await writeJson(claudeDiffPanelStorePath(configDir), { open: true })
    expect(await mayAutoOpen(120)).toBe(true)

    await writeFile(claudeDiffPanelStorePath(configDir), '{not json')
    expect(await mayAutoOpen(200)).toBe(false)
  })
})
