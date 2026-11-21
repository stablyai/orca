import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { removePluginHookFiles } from './opencode-pi-plugin-hook-files'

let root: string
let homeDir: string
let openCodeConfigDir: string

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-plugin-hook-files-'))
  homeDir = join(root, 'home')
  openCodeConfigDir = join(root, 'opencode')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('removePluginHookFiles', () => {
  it('removes Pi extensions carrying the Orca marker and keeps same-named user files', async () => {
    const extensions = join(homeDir, '.pi', 'agent', 'extensions')
    write(join(extensions, 'orca-agent-status.ts'), '// @orca-managed-pi-extension\nexport {}\n')
    write(join(extensions, 'orca-prefill.ts'), '// my own prefill\n')

    await removePluginHookFiles({ homeDir, openCodeConfigDir })

    expect(existsSync(join(extensions, 'orca-agent-status.ts'))).toBe(false)
    expect(readFileSync(join(extensions, 'orca-prefill.ts'), 'utf8')).toBe('// my own prefill\n')
  })

  it("removes Orca's OpenCode plugin and its TUI registration, keeping the user's plugins", async () => {
    const plugins = join(openCodeConfigDir, 'plugins')
    const tuiEntry = join(plugins, 'orca-opencode-status-tui', 'tui.js')
    write(join(plugins, 'orca-opencode-status.js'), 'process.env.ORCA_AGENT_HOOK_PORT\n')
    write(tuiEntry, 'process.env.ORCA_AGENT_HOOK_PORT\n')
    write(join(plugins, 'mine.js'), 'export default {}\n')
    write(
      join(openCodeConfigDir, 'tui.json'),
      JSON.stringify({ plugin: ['./mine.js', pathToFileURL(tuiEntry).href] }, null, 2)
    )

    await removePluginHookFiles({ homeDir, openCodeConfigDir })

    expect(existsSync(join(plugins, 'orca-opencode-status.js'))).toBe(false)
    expect(existsSync(dirname(tuiEntry))).toBe(false)
    expect(existsSync(join(plugins, 'mine.js'))).toBe(true)
    expect(JSON.parse(readFileSync(join(openCodeConfigDir, 'tui.json'), 'utf8'))).toEqual({
      plugin: ['./mine.js']
    })
  })
})
