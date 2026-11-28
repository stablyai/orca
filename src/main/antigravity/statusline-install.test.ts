import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
let settingsDir: string
let settingsPath: string
let scriptPath: string
let recordPath: string
const options = (): { homeDir: string } => ({ homeDir: home })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-agy-install-'))
  settingsDir = join(home, '.gemini', 'antigravity-cli')
  settingsPath = join(settingsDir, 'settings.json')
  scriptPath = join(home, '.orca', 'agent-hooks', 'antigravity-statusline.sh')
  recordPath = join(home, '.orca', 'agent-hooks', 'antigravity-statusline.json')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function seed(text: string): void {
  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(settingsPath, text)
}

const read = (): string => readFileSync(settingsPath, 'utf8')

describe.skipIf(process.platform === 'win32')('Antigravity status-line installer', () => {
  it.each([
    ['a user command', WITH_COMMAND],
    ['no statusLine key', WITHOUT_STATUS_LINE],
    ['four-space indent', WITHOUT_STATUS_LINE.replaceAll('  ', '    ')],
    ['tab indent, no trailing newline', WITH_COMMAND.replaceAll('  ', '\t').trimEnd()],
    ['compact JSON', '{"theme":"dark","tools":[1,2]}'],
    ['an empty object with inner spaces', '{  }\n'],
    [
      'comments and a default type',
      '{\n  // mine\n  "statusLine": {"command": "echo hi"} // keep\n}\n'
    ],
    ['a blank command', '{"statusLine":{"type":"command","command":"  "}}'],
    [
      'escaped characters in the command',
      WITH_COMMAND.replace(/"command": .*,/, '"command": "echo \\u0027x\\u0027 \\/ y",')
    ]
  ])('restores the original bytes after install and remove with %s', async (_name, original) => {
    seed(original)
    const result = await installAntigravityStatusLine(options())
    expect(result.state).toBe('installed')
    const installed = JSON.parse(read().replace(/\/\/.*$/gm, ''))
    expect(installed.statusLine.command).toBe(scriptPath)
    expect((await getAntigravityStatusLineStatus(options())).state).toBe('installed')

    expect((await removeAntigravityStatusLine(options())).state).toBe('not_installed')
    expect(read()).toBe(original)
    expect(existsSync(recordPath)).toBe(false)
  })

  it('restores an untouched install even when a later edit moved the file', async () => {
    seed(WITHOUT_STATUS_LINE)
    await installAntigravityStatusLine(options())
    writeFileSync(settingsPath, read().replace('"dark"', '"light"'))
    await removeAntigravityStatusLine(options())
    expect(read()).toBe(WITHOUT_STATUS_LINE.replace('"dark"', '"light"'))
  })

  it('keeps the user command running through the managed script, and installing twice changes nothing', async () => {
    seed(WITH_COMMAND)
    await installAntigravityStatusLine(options())
    const first = read()
    const run = spawnSync('sh', [scriptPath], { input: '{"a":1}' })
    expect(run.stdout.toString()).toBe("it's mine")

    await installAntigravityStatusLine(options())
    expect(read()).toBe(first)
    expect(spawnSync('sh', [scriptPath], { input: '{}' }).stdout.toString()).toBe("it's mine")
    await removeAntigravityStatusLine(options())
    expect(read()).toBe(WITH_COMMAND)
  })

  it('leaves a command the user changed after install', async () => {
    seed(WITH_COMMAND)
    await installAntigravityStatusLine(options())
    const changed = read().replace(scriptPath, '/usr/local/bin/mine')
    writeFileSync(settingsPath, changed)

    expect((await removeAntigravityStatusLine(options())).state).toBe('not_installed')
    expect(read()).toBe(changed)
  })

  it('keeps the managed script after removal so a running agy can still call it', async () => {
    seed(WITH_COMMAND)
    await installAntigravityStatusLine(options())
    await removeAntigravityStatusLine(options())
    expect(existsSync(scriptPath)).toBe(true)
  })

  it('reports an error and writes nothing for invalid JSON', async () => {
    seed('{ "theme": ')
    expect((await installAntigravityStatusLine(options())).state).toBe('error')
    expect((await removeAntigravityStatusLine(options())).state).toBe('error')
    expect(read()).toBe('{ "theme": ')
    expect(existsSync(scriptPath)).toBe(false)
    expect(existsSync(recordPath)).toBe(false)
  })

  it('creates and removes the settings file when none existed', async () => {
    await installAntigravityStatusLine(options())
    expect(JSON.parse(read()).statusLine.command).toBe(scriptPath)
    await removeAntigravityStatusLine(options())
    expect(existsSync(settingsPath)).toBe(false)
  })

  it.each([
    [
      'a statusLine that agy has turned off',
      '{"statusLine":{"command":"echo hi","enabled":false}}'
    ],
    ['a non-command statusLine', '{"statusLine":{"type":"static","command":"echo hi"}}'],
    ['duplicate statusLine keys', '{"statusLine":{"command":"a"},"statusLine":{"command":"b"}}'],
    ['duplicate command keys', '{"statusLine":{"command":"first","command":"last"}}']
  ])('refuses %s and leaves the file alone', async (_name, original) => {
    seed(original)
    expect((await installAntigravityStatusLine(options())).state).toBe('error')
    expect(read()).toBe(original)
  })

  it('names a turned-off status line in the error', async () => {
    seed('{"statusLine":{"command":"echo hi","enabled":false}}')
    expect((await installAntigravityStatusLine(options())).detail).toContain('turned off')
  })

  it('edits a symlinked settings.json through its target and keeps the link', async () => {
    const target = join(home, 'dotfiles-settings.json')
    writeFileSync(target, WITH_COMMAND)
    mkdirSync(settingsDir, { recursive: true })
    symlinkSync(target, settingsPath)

    await installAntigravityStatusLine(options())
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain(scriptPath)
    await removeAntigravityStatusLine(options())
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(WITH_COMMAND)
  })

  it('refuses a broken settings.json link', async () => {
    mkdirSync(settingsDir, { recursive: true })
    symlinkSync(join(home, 'missing.json'), settingsPath)
    expect((await installAntigravityStatusLine(options())).state).toBe('error')
    expect(existsSync(join(home, 'missing.json'))).toBe(false)
    expect(existsSync(recordPath)).toBe(false)
  })

  it('will not guess the original when the managed command has lost its restore record', async () => {
    seed(WITH_COMMAND)
    await installAntigravityStatusLine(options())
    rmSync(recordPath)
    const managed = read()

    expect((await getAntigravityStatusLineStatus(options())).state).toBe('error')
    expect((await installAntigravityStatusLine(options())).state).toBe('error')
    expect((await removeAntigravityStatusLine(options())).state).toBe('error')
    expect(read()).toBe(managed)
    expect(existsSync(scriptPath)).toBe(true)
  })

  it('keeps the user command and the restore data private', async () => {
    seed(WITH_COMMAND)
    chmodSync(settingsPath, 0o640)
    await installAntigravityStatusLine(options())
    expect(statSync(recordPath).mode & 0o777).toBe(0o600)
    expect(statSync(scriptPath).mode & 0o777).toBe(0o700)
    expect(statSync(settingsPath).mode & 0o777).toBe(0o640)
    await removeAntigravityStatusLine(options())
    rmSync(settingsPath)
    await installAntigravityStatusLine(options())
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600)
  })
})
