/** A process started from an interactive terminal (`orca serve`) must keep running while it probes the login shell. */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasZsh, ZSH_PATH } from '../../pty/shell-startup/zsh-startup-hook-pty-harness'

const DONE = 'ORCA-PROBE-PARENT-DONE'

// The parent touches its terminal mid-probe, as orcad's inherited stdio does during startup.
function fixtureSource(probe: 'login-environment' | 'path'): string {
  const call =
    probe === 'login-environment'
      ? `captureLoginShellEnvironment({ shellOverride: ${JSON.stringify(ZSH_PATH)} })`
      : `hydrateShellPath({ shellOverride: ${JSON.stringify(ZSH_PATH)} })`
  return `
    import { captureLoginShellEnvironment } from ${JSON.stringify(resolve('src/main/startup/shell-environment/login-shell-environment.ts'))};
    import { hydrateShellPath } from ${JSON.stringify(resolve('src/main/startup/shell-environment/hydrate-shell-path.ts'))};
    const probe = ${call};
    setTimeout(() => { process.stdin.setRawMode(true); process.stdin.setRawMode(false); }, 300);
    probe.then(() => { console.log(${JSON.stringify(DONE)}); process.exit(0); });
  `
}

describe.runIf(hasZsh)('login shell probes run from an interactive terminal', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'orca-shell-probe-tty-'))
    // A slow rc keeps the probe shell alive while the parent touches the terminal.
    writeFileSync(join(workDir, '.zshrc'), 'sleep 1\n')
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  async function runFromInteractiveShell(probe: 'login-environment' | 'path'): Promise<string> {
    const fixture = join(workDir, `${probe}.cjs`)
    await build({
      stdin: { contents: fixtureSource(probe), resolveDir: process.cwd(), loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      outfile: fixture,
      logLevel: 'silent'
    })
    // Job control in the outer shell is what puts a stolen-foreground parent into "suspended".
    const shell = pty.spawn(ZSH_PATH, ['-f', '-i'], {
      name: 'xterm-256color',
      cols: 200,
      rows: 40,
      cwd: workDir,
      env: { PATH: process.env.PATH ?? '', HOME: workDir, ZDOTDIR: workDir, TERM: 'xterm-256color' }
    })
    let output = ''
    // Settles on either verdict; a hang is left to the test timeout.
    const settled = new Promise<void>((settle) => {
      shell.onData((data) => {
        output += data
        if (output.includes(`${DONE}\r\n`) || /suspended/.test(output)) {
          settle()
        }
      })
    })
    try {
      shell.write(`${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}\r`)
      await settled
      return output
    } finally {
      shell.kill('SIGKILL')
    }
  }

  it.each(['login-environment', 'path'] as const)(
    'keeps the parent running through the %s probe',
    async (probe) => {
      const output = await runFromInteractiveShell(probe)
      expect(output).not.toMatch(/suspended/)
      expect(output).toContain(`${DONE}\r\n`)
    },
    30_000
  )
})
