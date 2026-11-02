import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type * as pty from 'node-pty'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadNodePtyForTests } from '../../orcad/orcad-node-slot-fixture'
import { markPtyRootAnchored, unmarkPtyRootAnchored } from '../../pty/anchored-pty-roots'
import { forceKillPosixPtyProcessGroups } from '../../pty/posix-pty-process-groups'
import { wrapPtySpawnInMacosTerminalAnchor } from './macos-terminal-anchor'

const describeMac = process.platform === 'darwin' ? describe : describe.skip
const WORKTREE = 'repo::/workspaces/anchor-test'
const TERMINAL = 'term_anchor_test'
const POLL_MS = 200

type Session = {
  proc: pty.IPty
  output: string
  exit: { exitCode: number; signal?: number } | null
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!check()) {
        throw new Error(`timed out waiting for ${label}`)
      }
    },
    { timeout: 10_000, interval: 20 }
  )
}

const isAlive = (pid: number): boolean => spawnSync('/bin/kill', ['-0', String(pid)]).status === 0

describeMac('the macOS terminal anchor in a real PTY', () => {
  let nodePty: typeof pty
  let work: string
  let helper: string
  const opened: pty.IPty[] = []
  const stragglers: number[] = []

  const origin = (
    pid: number
  ): { responsiblePid: number; worktreeId?: string; terminalHandle?: string } =>
    JSON.parse(execFileSync(helper, ['origin', String(pid)], { encoding: 'utf8' }))

  function open(file: string, args: string[]): Session {
    const wrapped = wrapPtySpawnInMacosTerminalAnchor(
      file,
      args,
      { ORCA_WORKTREE_ID: WORKTREE, ORCA_TERMINAL_HANDLE: TERMINAL },
      {
        platform: 'darwin',
        enabled: true,
        fileExists: () => true,
        paths: {
          helper,
          entry: join(work, 'terminal-anchor-entry.js'),
          node: process.execPath
        }
      }
    )
    const proc = nodePty.spawn(wrapped.file, wrapped.args, {
      cols: 80,
      rows: 24,
      cwd: work,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        TERM: 'xterm-256color',
        ORCA_TERMINAL_ANCHOR_POLL_MS: String(POLL_MS)
      }
    })
    opened.push(proc)
    const session: Session = { proc, output: '', exit: null }
    proc.onData((data) => {
      session.output += data
    })
    proc.onExit((exit) => {
      session.exit = exit
    })
    return session
  }

  /** Waits for a shell's answer; the marker is split in the command so its echo cannot match. */
  async function ask(session: Session, command: string): Promise<string> {
    const start = session.output.length
    session.proc.write(`${command}; echo DO""NE:$?\r`)
    await waitFor(() => /DONE:\d+/.test(session.output.slice(start)), `"${command}" to finish`)
    return session.output.slice(start)
  }

  async function shellPid(session: Session): Promise<number> {
    const answer = await ask(session, 'echo SHELL""PID:$$')
    return Number(/SHELLPID:(\d+)/.exec(answer)?.[1])
  }

  beforeAll(async () => {
    nodePty = await loadNodePtyForTests()
    work = mkdtempSync(join(tmpdir(), 'orca-terminal-anchor-'))
    helper = join(work, 'orca-terminal-anchor')
    execFileSync('swiftc', ['-O', resolve('native/terminal-anchor-macos/main.swift'), '-o', helper])
    // Named as the build names it. The module type lets the stripped source keep its imports.
    writeFileSync(join(work, 'package.json'), '{"type":"module"}')
    writeFileSync(
      join(work, 'terminal-anchor-entry.js'),
      stripTypeScriptTypes(
        readFileSync(resolve('src/main/daemon/terminal-anchor-entry.ts'), 'utf8')
      )
    )
  })

  afterEach(() => {
    for (const proc of opened.splice(0)) {
      try {
        proc.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    for (const pid of stragglers.splice(0)) {
      spawnSync('/bin/kill', ['-9', String(pid)])
    }
  })

  afterAll(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('names the terminal from every descendant, however it hides', async () => {
    const session = open('/bin/sh', [])
    const pid = await shellPid(session)
    const anchor = origin(pid)
    expect(anchor.responsiblePid).not.toBe(pid)
    expect(anchor.worktreeId).toBe(WORKTREE)
    expect(anchor.terminalHandle).toBe(TERMINAL)

    const start = session.output.length
    session.proc.write(
      `/usr/bin/perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; %ENV=(); print "DAEMON"."PID:$$\\n"; open(STDIN,"</dev/null"); open(STDOUT,">/dev/null"); open(STDERR,">/dev/null"); exec "/bin/sleep", "60"'\r`
    )
    await waitFor(() => /DAEMONPID:(\d+)/.test(session.output.slice(start)), 'the daemon')
    const daemon = Number(/DAEMONPID:(\d+)/.exec(session.output.slice(start))?.[1])
    stragglers.push(daemon)
    expect(origin(daemon).terminalHandle).toBe(TERMINAL)
    expect(
      execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(daemon)], { encoding: 'utf8' }).trim()
    ).toBe('1')
  })

  it('keeps ordinary terminal behavior', async () => {
    const session = open('/bin/zsh', ['-f'])
    await shellPid(session)
    expect(session.proc.process).toMatch(/zsh/)
    const start = session.output.length
    session.proc.write('sleep 90\r')
    await waitFor(() => /sleep/.test(session.proc.process), 'sleep to take the foreground')
    session.proc.write('\x03')
    await waitFor(() => /zsh/.test(session.proc.process), 'Ctrl-C to end only the command')
    expect(session.exit).toBeNull()
    expect(session.output.slice(start)).toContain('sleep 90')

    session.proc.resize(101, 37)
    expect(await ask(session, 'stty size')).toContain('37 101')
    expect(
      await ask(session, 'echo LE""AK"[$ELECTRON_RUN_AS_NODE][$ORCA_TERMINAL_ANCHOR_POLL_MS]"')
    ).toContain('LEAK[][]')
  })

  it.each([
    ['exit 7', { exitCode: 7, signal: 0 }],
    ['kill -TERM $$', { exitCode: 0, signal: 15 }]
  ])('reports the shell ending with %s', async (script, expected) => {
    const session = open('/bin/sh', ['-c', script])
    await waitFor(() => session.exit !== null, 'the terminal to close')
    expect(session.exit).toEqual(expected)
  })

  it('reports a shell that cannot start instead of hanging', async () => {
    const session = open('/nonexistent/shell', [])
    await waitFor(() => session.exit !== null, 'the terminal to close')
    expect(session.exit?.exitCode).toBe(127)
  })

  it('still runs the shell when the anchor cannot start', async () => {
    const proc = nodePty.spawn(
      helper,
      ['launch', '/nonexistent/host', '/nonexistent/entry', '', '', '/bin/sh', '-c', 'exit 5'],
      { cols: 80, rows: 24, cwd: work, env: { PATH: '/usr/bin:/bin' } }
    )
    opened.push(proc)
    const exit = await new Promise<{ exitCode: number }>((done) => proc.onExit(done))
    expect(exit.exitCode).toBe(5)
  })

  it('closes the terminal rather than hanging if the anchor is killed', async () => {
    const session = open('/bin/sh', [])
    const anchorPid = origin(await shellPid(session)).responsiblePid
    process.kill(anchorPid, 'SIGKILL')
    await waitFor(() => session.exit !== null, 'the terminal to close')
    expect(session.exit?.exitCode).toBe(1)
  })

  it('outlives the terminal for as long as anything still names it', async () => {
    const session = open('/bin/sh', [])
    const anchorPid = origin(await shellPid(session)).responsiblePid
    const start = session.output.length
    session.proc.write(
      `/usr/bin/perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; print "DAEMON"."PID:$$\\n"; open(STDIN,"</dev/null"); open(STDOUT,">/dev/null"); open(STDERR,">/dev/null"); exec "/bin/sleep", "60"'; exit 0\r`
    )
    await waitFor(() => /DAEMONPID:(\d+)/.test(session.output.slice(start)), 'the daemon')
    const daemon = Number(/DAEMONPID:(\d+)/.exec(session.output.slice(start))?.[1])
    stragglers.push(daemon)
    await waitFor(() => session.exit !== null, 'the terminal to close while the daemon lives')

    // ast-grep-ignore: test-no-real-time-wait -- proving it stays alive needs real poll intervals to pass
    await new Promise((done) => setTimeout(done, POLL_MS * 3))
    expect(isAlive(anchorPid)).toBe(true)
    expect(origin(daemon).terminalHandle).toBe(TERMINAL)

    spawnSync('/bin/kill', ['-9', String(daemon)])
    await waitFor(() => !isAlive(anchorPid), 'the anchor to exit once nothing names it')
  })

  it('survives the forced kill of its own terminal', async () => {
    const session = open('/bin/sh', [])
    const rootPid = session.proc.pid
    markPtyRootAnchored(rootPid)
    try {
      const anchorPid = origin(await shellPid(session)).responsiblePid
      const start = session.output.length
      session.proc.write(
        `/usr/bin/perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; print "DAEMON"."PID:$$\\n"; open(STDIN,"</dev/null"); open(STDOUT,">/dev/null"); open(STDERR,">/dev/null"); exec "/bin/sleep", "60"'\r`
      )
      await waitFor(() => /DAEMONPID:(\d+)/.test(session.output.slice(start)), 'the daemon')
      const daemon = Number(/DAEMONPID:(\d+)/.exec(session.output.slice(start))?.[1])
      stragglers.push(daemon)

      await forceKillPosixPtyProcessGroups(rootPid, () => process.kill(rootPid, 'SIGKILL'))
      await waitFor(() => session.exit !== null, 'the terminal to die')

      expect(isAlive(anchorPid)).toBe(true)
      expect(origin(daemon).terminalHandle).toBe(TERMINAL)
      spawnSync('/bin/kill', ['-9', String(daemon)])
      await waitFor(() => !isAlive(anchorPid), 'the anchor to exit afterwards')
    } finally {
      unmarkPtyRootAnchored(rootPid)
    }
  })
})
