import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from './single-instance-lock'

// Why #11935: a pre-`ready` graceful quit is deferred, so a lock-losing headless `orca serve`
// kept booting into Linux Ozone/X11 init, died with SIGSEGV, and systemd restarted it forever
// until the leaked AppImage FUSE mounts hit the kernel's 1000-mount ceiling.

function readSystemdUnitBlocks(doc: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>()
  // Why: key on the unit's path comment — splitting on directives mixes `[Unit]` and `[Service]` across blocks.
  for (const match of doc.matchAll(/^# \/etc\/systemd\/system\/(\S+\.service)$/gm)) {
    const start = match.index + match[0].length
    const name = match[1]
    blocks.set(name, [...(blocks.get(name) ?? []), doc.slice(start, doc.indexOf('```', start))])
  }
  return blocks
}

describe('headless lock-loss exit contract', () => {
  const preflightSource = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
    'utf8'
  )
  const entrySource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const doc = readFileSync(join(process.cwd(), 'docs/reference/headless-linux-server.md'), 'utf8')

  it('exits the lock-losing launch immediately instead of scheduling a graceful quit', () => {
    const gateStart = preflightSource.indexOf('if (!hasLock) {')
    // Why: bound the anchor — an unresolved indexOf slices to EOF and passes vacuously.
    expect(gateStart).toBeGreaterThanOrEqual(0)
    const gateEnd = preflightSource.indexOf('\n  }', gateStart)
    expect(gateEnd).toBeGreaterThan(gateStart)

    const gate = preflightSource.slice(gateStart, gateEnd)
    expect(gate).toContain('app.exit(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)')
    expect(gate).not.toContain('app.quit()')
  })

  it('keeps a duplicate serve launch from promoting the live server to a desktop window', () => {
    const activationStart = entrySource.indexOf('function requestDesktopActivation(')
    expect(activationStart).toBeGreaterThanOrEqual(0)
    const activationEnd = entrySource.indexOf('\n}', activationStart)
    expect(activationEnd).toBeGreaterThan(activationStart)

    expect(entrySource.slice(activationStart, activationEnd)).toContain(
      'shouldActivateDesktopForSecondInstance(argv)'
    )
  })

  it('makes every documented serve unit treat a duplicate owner as terminal', () => {
    const serveUnits = readSystemdUnitBlocks(doc).get('orca-serve.service') ?? []

    expect(serveUnits.length).toBeGreaterThan(0)
    for (const unit of serveUnits) {
      expect(unit).toContain(
        `RestartPreventExitStatus=${SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE}`
      )
      expect(unit).toContain('StartLimitIntervalSec=')
      expect(unit).toContain('StartLimitBurst=')
    }
  })

  it('clears the start limit before every scripted start, which a tripped burst would refuse', () => {
    const lines = doc.split('\n')
    const startLines = lines.flatMap((line, index) =>
      /^\s*sudo systemctl start orca-serve/.test(line) ? [index] : []
    )

    expect(startLines.length).toBeGreaterThan(0)
    for (const index of startLines) {
      expect(lines.slice(Math.max(0, index - 3), index).join('\n')).toContain(
        'systemctl reset-failed orca-serve'
      )
    }
  })

  it('leaves the Xvfb unit free to self-heal from a transient display flap', () => {
    const xvfbUnits = readSystemdUnitBlocks(doc).get('orca-xvfb.service') ?? []

    expect(xvfbUnits.length).toBeGreaterThan(0)
    // Why: a start limit here would down the display unit permanently and take orca-serve with it.
    for (const unit of xvfbUnits) {
      expect(unit).not.toContain('StartLimitBurst=')
    }
  })
})
