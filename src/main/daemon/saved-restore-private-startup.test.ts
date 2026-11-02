import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveFishBinary } from '../../shared/fish-binary-requirement'
import { getSavedRestoreActionFiles } from '../../shared/saved-restore-dispatch'
import {
  getFishSavedRestoreScript,
  getPosixSavedRestoreScript
} from '../../shared/saved-restore-scripts'
import { STARTUP_COMMAND_FEATURES } from '../shell-startup-launch-intent-fixtures'

// The default daemon's real wrappers on a real TTY: a launch whose root owns a saved restore's
// start shows the plain command once, after readiness, runs the agent in the foreground, and leaves
// nothing a later typed or recalled line can use.
const READY = '\x1b]777;orca-shell-ready\x07'
const ORIGINAL = "claude '--resume' 'X'"
const homes: string[] = []
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })))

const SHELLS = [
  { name: 'bash', path: '/bin/bash', available: existsSync('/bin/bash') },
  { name: 'zsh', path: 'zsh', available: spawnSync('zsh', ['--version']).status === 0 },
  {
    name: 'fish',
    // The pane's PATH below holds only the stand-ins, so spawn the fish this machine resolves.
    path: spawnSync('/bin/sh', ['-c', 'command -v fish'], { encoding: 'utf8' }).stdout.trim(),
    available: resolveFishBinary().available
  }
].filter((shell) => process.platform !== 'win32' && shell.available)

async function startArmed(shell: (typeof SHELLS)[number]) {
  const home = mkdtempSync(join(tmpdir(), `orca-sr-${shell.name}-`))
  homes.push(home)
  vi.stubEnv('ORCA_USER_DATA_PATH', join(home, 'user-data'))
  vi.resetModules()
  const { getShellLaunchConfig } = await import('./shell-ready')
  const config = getShellLaunchConfig(shell.path, STARTUP_COMMAND_FEATURES, {
    hasStartupCommand: true,
    inheritedXdgDataDirs: undefined,
    savedRestore: true
  })
  const bin = join(home, 'bin')
  mkdirSync(bin)
  // fish's login setup reorders PATH; the user's own config puts the stand-ins first again.
  mkdirSync(join(home, '.config', 'fish'), { recursive: true })
  writeFileSync(join(home, '.config', 'fish', 'config.fish'), `set -gx PATH ${bin} $PATH\n`)
  const log = join(home, 'check.log')
  writeFileSync(
    join(bin, 'orca'),
    `#!/bin/sh\n[ "$3" = --phase ] && { echo dispatched >> "${log}"; exit 0; }\necho check >> "${log}"\ncat >/dev/null\nexit 75\n`
  )
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "AGENT[$*]"\n`)
  chmodSync(join(bin, 'orca'), 0o755)
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(join(home, 'restore.sh'), getPosixSavedRestoreScript())
  writeFileSync(join(home, 'restore.fish'), getFishSavedRestoreScript())
  const files = getSavedRestoreActionFiles({
    entry: '0123456789abcdef',
    token: '0123456789abcdef0123456789abcdef',
    agent: 'claude',
    resumeArgs: ['--resume', 'X'],
    freshArgs: ['--fresh', 'a b']
  })
  writeFileSync(join(home, 'action.sh'), files.sh)
  writeFileSync(join(home, 'action.fish'), files.fish)
  const pty = await import('node-pty')
  const proc = pty.spawn(shell.path, config.args ?? [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: home,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      // Login profiles reorder PATH; this puts the stand-in agent first again after them, so the
      // recall below can only reach it (the fresh step proves which agent ran before any recall).
      ORCA_CLI_BIN_DIR: bin,
      HOME: home,
      TERM: 'xterm-256color',
      ...config.env,
      ORCA_SAVED_RESTORE_CHECK: join(bin, 'orca'),
      ORCA_SAVED_RESTORE_ACTION: join(home, 'action'),
      ORCA_SAVED_RESTORE_SCRIPT: join(home, 'restore'),
      ORCA_SAVED_RESTORE_ORIGINAL: ORIGINAL
    }
  })
  let output = ''
  proc.onData((chunk) => {
    output += chunk
    // Answer cursor-position and attribute queries so fish can finish drawing its prompt.
    if (chunk.includes('\x1b[6n')) {
      proc.write('\x1b[1;1R')
    }
    if (chunk.includes('\x1b[0c')) {
      proc.write('\x1b[?6c')
    }
  })
  const until = (seen: () => boolean) =>
    vi.waitFor(() => expect(seen(), JSON.stringify(output.slice(-1500))).toBe(true), {
      timeout: 10_000,
      interval: 50
    })
  const checks = () =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  return { config, proc, output: () => output, until, checks }
}

describe.each(SHELLS)('the daemon $name wrapper owning a saved restore start', (shell) => {
  it('marks ready, shows only the plain command, runs fresh once, and a recall is ordinary', async () => {
    const run = await startArmed(shell)
    expect(run.config.ownsSavedRestore).toBe(true)
    try {
      await run.until(() => run.output().includes('AGENT[--fresh a b]'))
      const first = run.output()
      expect(first.indexOf(READY)).toBeGreaterThanOrEqual(0)
      expect(first.indexOf(READY)).toBeLessThan(first.indexOf(ORIGINAL))
      expect(first).not.toContain('__orca')
      run.proc.write(`${ORIGINAL}\r`)
      await run.until(() => run.output().includes('AGENT[--resume X]'))
      expect(run.output()).not.toContain('__orca')
      await run.until(() => run.checks().includes('dispatched'))
      expect(run.checks().filter((line) => line === 'check')).toHaveLength(1)
    } finally {
      run.proc.kill()
    }
  }, 20_000)
})
