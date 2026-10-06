import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planCodexNoDaemonLaunch, type LocalCodexLaunch } from './codex-no-daemon-launch-command'

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

  it('probes the trusted canonical profile executable even with a different filename', async () => {
    const canonical = writeCodex('provider-native', HELP_WITH_FLAG)
    await expect(plan(canonical, { trustedExecutable: canonical })).resolves.toBe(
      `${canonical} --no-daemon`
    )
    expect(plan(canonical)).toBeNull()
  })

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
