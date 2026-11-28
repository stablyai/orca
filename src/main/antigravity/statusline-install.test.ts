import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getAntigravityStatusLineStatus,
  installAntigravityStatusLine,
  removeAntigravityStatusLine
} from './statusline-install'

const USER_COMMAND = `printf '%s' "it's mine" | cat`
const WITH_COMMAND = `{
  "theme": "dark",
  "statusLine": {
    "type": "command",
    "command": ${JSON.stringify(USER_COMMAND)},
    "padding": 1
  },
  "tools": [1, 2]
}
`
const WITHOUT_STATUS_LINE = `{
  "theme": "dark",
  "tools": [1, 2]
}
`

let home: string
let settingsPath: string
let scriptPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-agy-install-'))
  settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json')
  scriptPath = join(home, '.orca', 'agent-hooks', 'antigravity-statusline.sh')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function seed(text: string): void {
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  writeFileSync(settingsPath, text)
}

function readCommand(): string {
  return JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine.command
}

describe.skipIf(process.platform === 'win32')('Antigravity status-line installer', () => {
  it.each([
    ['a user command', WITH_COMMAND],
    ['no statusLine key', WITHOUT_STATUS_LINE],
    [
      'escaped characters in the command',
      WITH_COMMAND.replace(/"command": .*,/, '"command": "echo \\u0027x\\u0027 \\/ y",')
    ],
    ['four-space indent', WITHOUT_STATUS_LINE.replaceAll('  ', '    ')],
    ['tab indent, no trailing newline', WITH_COMMAND.replaceAll('  ', '\t').trimEnd()],
    ['compact JSON', '{"theme":"dark","tools":[1,2]}']
  ])('restores the original bytes after install and remove with %s', async (_name, original) => {
    seed(original)
    expect((await installAntigravityStatusLine({ homeDir: home })).state).toBe('installed')
    const installed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(installed.theme).toBe('dark')
    expect(installed.tools).toEqual([1, 2])
    expect(installed.statusLine.type).toBe('command')
    expect(installed.statusLine.command).toBe(scriptPath)
    expect(statSync(scriptPath).mode & 0o111).not.toBe(0)
    expect((await getAntigravityStatusLineStatus({ homeDir: home })).state).toBe('installed')

    expect((await removeAntigravityStatusLine({ homeDir: home })).state).toBe('not_installed')
    expect(readFileSync(settingsPath, 'utf8')).toBe(original)
    expect(existsSync(scriptPath)).toBe(false)
  })

  it('wraps the user command and keeps it after a repeated install', async () => {
    seed(WITH_COMMAND)
    await installAntigravityStatusLine({ homeDir: home })
    const first = readFileSync(settingsPath, 'utf8')
    const firstScript = readFileSync(scriptPath, 'utf8')
    expect(firstScript).toContain(`'printf '\\''%s'\\'' "it'\\''s mine" | cat'`)

    await installAntigravityStatusLine({ homeDir: home })
    expect(readFileSync(settingsPath, 'utf8')).toBe(first)
    expect(readFileSync(scriptPath, 'utf8')).toBe(firstScript)

    await removeAntigravityStatusLine({ homeDir: home })
    expect(readFileSync(settingsPath, 'utf8')).toBe(WITH_COMMAND)
  })

  it('leaves a command the user changed after install', async () => {
    seed(WITH_COMMAND)
    await installAntigravityStatusLine({ homeDir: home })
    const changed = readFileSync(settingsPath, 'utf8').replace(scriptPath, '/usr/local/bin/mine')
    writeFileSync(settingsPath, changed)

    expect((await removeAntigravityStatusLine({ homeDir: home })).state).toBe('not_installed')
    expect(readFileSync(settingsPath, 'utf8')).toBe(changed)
    expect(readCommand()).toBe('/usr/local/bin/mine')
    expect(existsSync(scriptPath)).toBe(false)
  })

  it('reports an error and writes nothing for invalid JSON', async () => {
    seed('{ "theme": ')
    const result = await installAntigravityStatusLine({ homeDir: home })
    expect(result.state).toBe('error')
    expect((await removeAntigravityStatusLine({ homeDir: home })).state).toBe('error')
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ "theme": ')
    expect(existsSync(scriptPath)).toBe(false)
  })

  it('creates and removes the settings file when none existed', async () => {
    await installAntigravityStatusLine({ homeDir: home })
    expect(readCommand()).toBe(scriptPath)
    await removeAntigravityStatusLine({ homeDir: home })
    expect(existsSync(settingsPath)).toBe(false)
  })
})
