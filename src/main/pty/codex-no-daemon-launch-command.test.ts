import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { syncCodexHookFlags } = vi.hoisted(() => ({ syncCodexHookFlags: vi.fn(async () => {}) }))
vi.mock('../codex/codex-hook-flag-sync', () => ({ syncCodexHookFlags }))

import { planCodexNoDaemonLaunch, type LocalCodexLaunch } from './codex-no-daemon-launch-command'
import { publishCodexHookFlagEntry } from '../codex/codex-hook-flag-table'

const HELP_WITH_FLAG = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-daemon  Run in-process\n'
const HELP_WITHOUT_FLAG = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-alt-screen\n'
const hostPlatform = process.platform

describe.skipIf(hostPlatform === 'win32')('planCodexNoDaemonLaunch', () => {
  let dir: string
  let codex: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-codex-no-daemon-launch-'))
    codex = writeCodex('codex', HELP_WITH_FLAG)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  function writeCodex(name: string, help: string): string {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `#!/bin/sh\nprintf '%s' '${help}'\n`)
    chmodSync(path, 0o755)
    return path
  }

  function plan(command: string, overrides: Partial<LocalCodexLaunch> = {}) {
    return planCodexNoDaemonLaunch({
      command,
      executesOnThisHost: true,
      shellOverride: undefined,
      env: {},
      cwd: dir,
      ...overrides
    })
  }

  it('adds --no-daemon once, right after a path-named codex', async () => {
    await expect(plan(`${codex} --yolo 'fix the bug'`)).resolves.toBe(
      `${codex} --no-daemon --yolo 'fix the bug'`
    )
  })

  it.each([
    ['agents'],
    ['queue --thread T'],
    ['--no-daemon'],
    ['resume --no-daemon'],
    ['--remote unix://'],
    ['--remote=ws://h:1']
  ])('leaves `codex %s` alone: it needs the shared server or has the flag', (args) => {
    expect(plan(`${codex} ${args}`)).toBeNull()
  })

  it('leaves SSH and WSL launches to the codex function on that host', () => {
    expect(plan(`${codex} --yolo`, { executesOnThisHost: false })).toBeNull()
  })

  it('ignores an inherited opt-out the pane deletes', async () => {
    vi.stubEnv('ORCA_CODEX_ISOLATE', '0')

    await expect(plan(`${codex} --yolo`, { envToDelete: ['ORCA_CODEX_ISOLATE'] })).resolves.toBe(
      `${codex} --no-daemon --yolo`
    )
  })

  it('honours ORCA_CODEX_ISOLATE=0 from the pane env', () => {
    expect(plan(`${codex} --yolo`, { env: { ORCA_CODEX_ISOLATE: '0' } })).toBeNull()
  })

  it('keeps the command when the binary predates --no-daemon', async () => {
    const oldCodex = writeCodex('0.155/codex', HELP_WITHOUT_FLAG)

    await expect(plan(`${oldCodex} --yolo`)).resolves.toBe(`${oldCodex} --yolo`)
  })

  it.each([['codex --yolo'], ['claude --yolo'], ['/opt/bin/codexx --yolo']])(
    'leaves `%s` to the shell function or to another agent',
    (command) => {
      expect(plan(command)).toBeNull()
    }
  )

  it('probes a bare codex on PATH for cmd.exe, which has no codex function', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    writeCodex('codex.exe', HELP_WITH_FLAG)

    await expect(
      plan('codex --yolo', {
        shellOverride: 'cmd.exe',
        env: { PATH: dir, PATHEXT: '.exe' }
      })
    ).resolves.toBe('codex --no-daemon --yolo')
  })
})

describe.skipIf(hostPlatform === 'win32')('planCodexNoDaemonLaunch status hook flag', () => {
  let dir: string
  let codexHome: string
  let table: string
  const FLAG = 'hooks={Stop=[]}'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-codex-hook-flag-launch-'))
    codexHome = join(dir, 'codex-home')
    table = join(dir, 'codex-hook-flags')
    mkdirSync(codexHome)
    mkdirSync(table)
    publishCodexHookFlagEntry(
      { codexVersion: 'codex-cli 9.9.9', flag: FLAG, noDaemon: false },
      table
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeVersionedCodex(version: string, help = 'Usage: codex', name = 'codex'): string {
    const path = join(dir, 'bin', name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo '${version}'; exit 0; fi\nprintf '%s' '${help}'\n`
    )
    chmodSync(path, 0o755)
    return path
  }

  function plan(command: string) {
    return planCodexNoDaemonLaunch({
      command,
      executesOnThisHost: true,
      shellOverride: undefined,
      env: {},
      cwd: dir,
      hookFlagTable: table,
      codexHomePath: codexHome
    })
  }

  it("carries the table's entry after a path-named codex of that version", async () => {
    const codex = writeVersionedCodex('codex-cli 9.9.9')
    await expect(plan(`${codex} resume --last`)).resolves.toBe(
      `${codex} -c '${FLAG}' resume --last`
    )
  })

  it('never carries another version’s entry, and asks Orca for its own', async () => {
    const codex = writeVersionedCodex('codex-cli 9.9.10')
    syncCodexHookFlags.mockClear()
    await expect(plan(`${codex} resume --last`)).resolves.toBe(`${codex} resume --last`)
    expect(syncCodexHookFlags).toHaveBeenCalledWith({ codexPath: codex })
  })

  it('carries nothing into a home that still holds an Orca file entry', async () => {
    const codex = writeVersionedCodex('codex-cli 9.9.9')
    writeFileSync(
      join(codexHome, 'hooks.json'),
      '{"hooks":{"Stop":[{"hooks":[{"command":"/x/.orca/agent-hooks/codex-hook.sh"}]}]}}'
    )
    await expect(plan(`${codex} resume --last`)).resolves.toBe(`${codex} resume --last`)
  })

  it("still carries beside the user's own hook that merely shares the script's name", async () => {
    const codex = writeVersionedCodex('codex-cli 9.9.9')
    writeFileSync(
      join(codexHome, 'hooks.json'),
      '{"hooks":{"Stop":[{"hooks":[{"command":"~/bin/codex-hook.sh"}]}]}}'
    )
    await expect(plan(`${codex} resume`)).resolves.toBe(`${codex} -c '${FLAG}' resume`)
  })

  it.each([
    ["-c 'hooks.state={}'"],
    ["-c='hooks.state={}'"],
    ["-c ' hooks.state={}'"],
    ["--config 'hooks={}'"],
    ["--config=' hooks.Stop=[]'"],
    ['-chooks.Stop=[]']
  ])("carries nothing beside the user's own hooks override %s", async (override) => {
    const codex = writeVersionedCodex('codex-cli 9.9.9')
    await expect(plan(`${codex} ${override} resume`)).resolves.toBe(`${codex} ${override} resume`)
  })

  it("carries nothing beside the user's own hooks override", async () => {
    const codex = writeVersionedCodex('codex-cli 9.9.9')
    await expect(plan(`${codex} -c 'hooks.state={}' resume`)).resolves.toBe(
      `${codex} -c 'hooks.state={}' resume`
    )
  })

  it('takes --no-daemon from the entry instead of probing --help', async () => {
    const codex = writeVersionedCodex('codex-cli 9.9.9', HELP_WITH_FLAG)
    await expect(plan(`${codex} resume`)).resolves.toBe(`${codex} -c '${FLAG}' resume`)
    publishCodexHookFlagEntry(
      { codexVersion: 'codex-cli 9.9.9', flag: FLAG, noDaemon: true },
      table
    )
    await expect(plan(`${codex} resume`)).resolves.toBe(`${codex} --no-daemon -c '${FLAG}' resume`)
  })

  function planIn(command: string, options: Partial<LocalCodexLaunch>) {
    return planCodexNoDaemonLaunch({
      command,
      executesOnThisHost: true,
      shellOverride: undefined,
      env: {},
      cwd: dir,
      hookFlagTable: table,
      ...options
    })
  }

  const ORCA_ENTRY =
    '{"hooks":{"Stop":[{"hooks":[{"command":"/x/.orca/agent-hooks/codex-hook.sh"}]}]}}'

  it("checks the pane's CODEX_HOME for an older Orca entry when no home was selected", async () => {
    const codex = writeVersionedCodex('codex-cli 9.9.9')
    writeFileSync(join(codexHome, 'hooks.json'), ORCA_ENTRY)
    await expect(planIn(`${codex} resume`, { env: { CODEX_HOME: codexHome } })).resolves.toBe(
      `${codex} resume`
    )
  })

  it('checks the default ~/.codex for an older Orca entry when nothing names a home', async () => {
    const codex = writeVersionedCodex('codex-cli 9.9.9')
    const home = join(dir, 'home')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'hooks.json'), ORCA_ENTRY)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CODEX_HOME', '')
    try {
      await expect(planIn(`${codex} resume`, { codexHomePath: null })).resolves.toBe(
        `${codex} resume`
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // Why: cmd.exe defines no codex function, so an Orca-launched bare `codex` gets the flag here or not at all.
  it("carries the entry for cmd.exe's bare codex, resolved on the pane's PATH", async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      writeVersionedCodex('codex-cli 9.9.9', 'Usage: codex', 'codex.exe')
      const cmd = { shellOverride: 'cmd.exe', env: { PATH: join(dir, 'bin'), PATHEXT: '.exe' } }
      await expect(planIn('codex resume', cmd)).resolves.toBe(`codex -c "${FLAG}" resume`)

      const newer = writeVersionedCodex('codex-cli 9.9.10', 'Usage: codex', 'codex.exe')
      syncCodexHookFlags.mockClear()
      await expect(planIn('codex resume', cmd)).resolves.toBe('codex resume')
      expect(syncCodexHookFlags).toHaveBeenCalledWith({ codexPath: newer })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
    }
  })

  it("finds Codex's version line after output a shell startup printed first", async () => {
    const codex = writeVersionedCodex('conda activated\ncodex-cli 9.9.9')
    await expect(plan(`${codex} resume`)).resolves.toBe(`${codex} -c '${FLAG}' resume`)
  })

  it('probes nothing while hooks are off, which removes the table', () => {
    const codex = writeVersionedCodex('codex-cli 9.9.9')
    rmSync(table, { recursive: true })
    expect(plan(`${codex} agents`)).toBeNull()
  })

  it('leaves a bare codex to the shell function, which carries the flag itself', () => {
    writeVersionedCodex('codex-cli 9.9.9')
    expect(plan('codex resume --last')).toBeNull()
  })

  it('still carries the flag for a shared-server subcommand, which keeps no --no-daemon', async () => {
    const codex = writeVersionedCodex('codex-cli 9.9.9')
    await expect(plan(`${codex} agents`)).resolves.toBe(`${codex} -c '${FLAG}' agents`)
  })
})
