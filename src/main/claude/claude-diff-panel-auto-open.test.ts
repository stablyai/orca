import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseClaudeCliVersionOutput } from './claude-hook-event-versions'
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
  it('names the store file the way Claude 2.1.301 does', () => {
    expect(claudeDiffPanelStorePath(configDir)).toBe(
      join(configDir, 'plugins', 'store', 'cc-plugin-diff_builtin-3903e77c01b1.json')
    )
  })

  it('answers false for a Claude older than the panel, or an unknown version', async () => {
    for (const [output, expected] of [
      ['11.17.0', false],
      ['launcher 11.17.0\n1.0.64 (Claude Code)', false],
      ['launcher 0.1.0\n2.1.310 (Claude Code)', true]
    ] as const) {
      expect(await mayAutoOpen(200, { version: parseClaudeCliVersionOutput(output) })).toBe(
        expected
      )
    }
    expect(await mayAutoOpen(200, { version: '2.1.259' })).toBe(false)
    expect(await mayAutoOpen(200, { version: '2.1.260' })).toBe(true)
  })

  it('opens unasked only from 144 columns when the user never chose', async () => {
    expect(await mayAutoOpen(143)).toBe(false)
    expect(await mayAutoOpen(144)).toBe(true)
    expect(await mayAutoOpen(null)).toBe(true)
  })

  it('opens from 110 columns once the user has opened the panel before', async () => {
    await writeJson(claudeDiffPanelStorePath(configDir), { open: true })
    expect(await mayAutoOpen(109)).toBe(false)
    expect(await mayAutoOpen(110)).toBe(true)
  })

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

  it('answers false when the user opted out of the fullscreen renderer', async () => {
    await writeJson(join(configDir, 'settings.json'), { tui: 'default' })
    expect(await mayAutoOpen(200)).toBe(false)
    await writeJson(join(configDir, 'settings.json'), { tui: 'fullscreen' })
    expect(await mayAutoOpen(200)).toBe(true)
  })
})
