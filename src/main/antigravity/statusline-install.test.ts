import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
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
    ['a default type', '{\n  "statusLine": {"command": "echo hi"}\n}\n'],
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
    ['duplicate command keys', '{"statusLine":{"command":"first","command":"last"}}'],
    ['comments', '{\n  // mine\n  "statusLine": {"command": "echo hi"} // keep\n}\n'],
    ['comments in an empty object', '{ /* nothing yet */ }']
  ])('refuses %s and leaves the file alone', async (_name, original) => {
    seed(original)
    expect((await installAntigravityStatusLine(options())).state).toBe('error')
    expect(read()).toBe(original)
  })

  it('will not splice a file that gained comments after install, but loses nothing', async () => {
    seed(WITHOUT_STATUS_LINE)
    await installAntigravityStatusLine(options())
    const edited = read().replace('"theme"', '// mine\n  "theme"').replace('"dark"', '"light"')
    writeFileSync(settingsPath, edited)
    expect((await removeAntigravityStatusLine(options())).state).toBe('error')
    expect(read()).toBe(edited)
    expect(existsSync(recordPath)).toBe(true)
  })

  it('restores the command while agy has the status line turned off, keeping that switch', async () => {
    seed(WITH_COMMAND)
    await installAntigravityStatusLine(options())
    writeFileSync(settingsPath, read().replace('"padding": 1', '"padding": 1, "enabled": false'))
    expect((await getAntigravityStatusLineStatus(options())).state).toBe('installed')
    expect((await removeAntigravityStatusLine(options())).state).toBe('not_installed')
    expect(read()).toBe(WITH_COMMAND.replace('"padding": 1', '"padding": 1, "enabled": false'))
  })

  it('reports an error, not "not installed", when a record exists but settings cannot be read', async () => {
    seed(WITH_COMMAND)
    await installAntigravityStatusLine(options())
    writeFileSync(settingsPath, '{ "broken": ')
    expect((await getAntigravityStatusLineStatus(options())).state).toBe('error')
    expect((await removeAntigravityStatusLine(options())).state).toBe('error')
    expect(existsSync(recordPath)).toBe(true)
  })

  it('keeps keys the user added to a statusLine Orca created, and drops only its own', async () => {
    seed(WITHOUT_STATUS_LINE)
    await installAntigravityStatusLine(options())
    writeFileSync(
      settingsPath,
      read().replace(
        /"command": "[^"]*"/,
        (command) => `${command}, "enabled": false, "padding": 2`
      )
    )
    expect((await removeAntigravityStatusLine(options())).state).toBe('not_installed')
    expect(JSON.parse(read()).statusLine).toEqual({ enabled: false, padding: 2 })
    expect(JSON.parse(read()).theme).toBe('dark')
  })

  it('keeps the restore record while a duplicate key makes the slot ambiguous', async () => {
    seed(WITH_COMMAND)
    await installAntigravityStatusLine(options())
    const ambiguous = read().replace('"type": "command",', '"type": "command","command": "other",')
    writeFileSync(settingsPath, ambiguous)
    expect((await getAntigravityStatusLineStatus(options())).state).toBe('error')
    expect((await removeAntigravityStatusLine(options())).state).toBe('error')
    expect(read()).toBe(ambiguous)
    expect(existsSync(recordPath)).toBe(true)
    // Once the extra key is gone, the record still restores the original.
    writeFileSync(settingsPath, read().replace('"command": "other",', ''))
    expect((await removeAntigravityStatusLine(options())).state).toBe('not_installed')
    expect(read()).toBe(WITH_COMMAND)
  })

  it.skipIf(process.getuid?.() === 0)(
    'will not replace or roll back an existing script it cannot read',
    async () => {
      seed(WITH_COMMAND)
      await installAntigravityStatusLine(options())
      await removeAntigravityStatusLine(options())
      chmodSync(scriptPath, 0o000)
      try {
        expect((await installAntigravityStatusLine(options())).state).toBe('error')
        expect(read()).toBe(WITH_COMMAND)
        expect(existsSync(scriptPath)).toBe(true)
      } finally {
        chmodSync(scriptPath, 0o700)
      }
    }
  )

  it('stops the kept script posting as soon as the feature is turned off, even if settings are broken', async () => {
    const posts: string[] = []
    const server = createServer((req, res) => {
      posts.push(req.url ?? '')
      req.resume()
      res.writeHead(204).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const callScript = (pane: string): Promise<void> =>
      new Promise((resolve) => {
        const child = spawn('sh', [scriptPath], {
          env: {
            PATH: process.env.PATH ?? '',
            TMPDIR: home,
            ORCA_AGENT_HOOK_PORT: String(port),
            ORCA_AGENT_HOOK_TOKEN: 't',
            ORCA_PANE_KEY: pane
          }
        })
        child.on('close', () => resolve())
        child.stdin.end('{"quota":{"gemini-5h":{"remaining_fraction":0.5}}}')
      })
    try {
      seed(WITH_COMMAND)
      await installAntigravityStatusLine(options())
      await callScript('tab:11111111-1111-1111-1111-111111111111')
      await expect.poll(() => posts.length).toBe(1)

      writeFileSync(settingsPath, '{ "broken": ')
      expect((await removeAntigravityStatusLine(options())).state).toBe('error')
      await callScript('tab:22222222-2222-2222-2222-222222222222')
      // ast-grep-ignore: test-no-real-time-wait -- absence of a background POST can only be shown by waiting past a localhost round trip
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(posts).toHaveLength(1)
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it.skipIf(process.getuid?.() === 0)(
    'never deletes a restore record it cannot read, and uses it again once readable',
    async () => {
      seed(WITH_COMMAND)
      await installAntigravityStatusLine(options())
      const ambiguous = read().replace(
        '"type": "command",',
        '"type": "command","command": "other",'
      )
      writeFileSync(settingsPath, ambiguous)
      chmodSync(recordPath, 0o000)
      try {
        expect((await getAntigravityStatusLineStatus(options())).state).toBe('error')
        expect((await removeAntigravityStatusLine(options())).state).toBe('error')
        expect((await installAntigravityStatusLine(options())).state).toBe('error')
        expect(existsSync(recordPath)).toBe(true)
      } finally {
        chmodSync(recordPath, 0o600)
      }
      writeFileSync(settingsPath, ambiguous.replace('"command": "other",', ''))
      expect((await removeAntigravityStatusLine(options())).state).toBe('not_installed')
      expect(read()).toBe(WITH_COMMAND)
    }
  )

  it('applies nothing from a restore record that belongs to another install', async () => {
    seed(WITH_COMMAND)
    await installAntigravityStatusLine(options())
    const installed = read()
    const script = readFileSync(scriptPath, 'utf8')
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    writeFileSync(
      recordPath,
      JSON.stringify({
        ...record,
        installedCommand: '/elsewhere/wrapper.sh',
        originalCommand: 'echo other'
      })
    )
    expect((await removeAntigravityStatusLine(options())).state).toBe('error')
    expect(read()).toBe(installed)
    expect(readFileSync(scriptPath, 'utf8')).toBe(script)
    expect(existsSync(recordPath)).toBe(true)
  })

  it("treats a statusLine of the user's own settings without a command as an empty slot", async () => {
    seed(WITHOUT_STATUS_LINE)
    await installAntigravityStatusLine(options())
    writeFileSync(
      settingsPath,
      read().replace(/"command": "[^"]*"/, (m) => `${m}, "padding": 2`)
    )
    await removeAntigravityStatusLine(options())
    const kept = read()
    expect(JSON.parse(kept)).toEqual({ theme: 'dark', tools: [1, 2], statusLine: { padding: 2 } })

    expect((await installAntigravityStatusLine(options())).state).toBe('installed')
    expect(JSON.parse(read()).statusLine).toEqual({
      padding: 2,
      type: 'command',
      command: scriptPath
    })
    expect((await removeAntigravityStatusLine(options())).state).toBe('not_installed')
    expect(read()).toBe(kept)
  })

  it('fills a bare statusLine that already has a type and keeps it on remove', async () => {
    const original = '{"statusLine":{"type":"command","padding":1}}'
    seed(original)
    await installAntigravityStatusLine(options())
    writeFileSync(settingsPath, read().replace('"padding":1', '"padding":3'))
    await removeAntigravityStatusLine(options())
    expect(JSON.parse(read()).statusLine).toEqual({ type: 'command', padding: 3 })
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
