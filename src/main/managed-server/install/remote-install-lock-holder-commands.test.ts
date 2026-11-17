// Run the holder, fence, probe and steal scripts in /bin/sh against a real kernel lock.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tryStealInstallLockCommand } from './remote-install-lock-commands'
import { removeOwnedInstallLockCommand } from './remote-install-lock-owner-commands'
import {
  INSTALL_LOCK_HOLDER_FILENAME,
  installLockFenceStatement,
  installLockHolderCommand,
  installLockHolderExitedProbeCommand,
  installLockHolderUnmarkCommand,
  installLockOwnedByCommand,
  installLockReleaseGate,
  parseInstallLockHolderExit
} from './remote-install-lock-holder-commands'
import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'

const host = getRemoteHostPlatform('linux-x64')
const OWNER = '.orca-fence-owner'
const first = { fileName: OWNER, token: 't-first' }
const second = { fileName: OWNER, token: 't-second' }
const hasFlock =
  process.platform !== 'win32' && spawnSync('/bin/sh', ['-c', 'command -v flock']).status === 0

const roots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function lockOwnedBy(token: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-lock-holder-'))
  roots.push(root)
  const lock = join(root, '.install-lock')
  mkdirSync(lock)
  writeFileSync(join(lock, OWNER), token)
  return lock
}

function sh(command: string, env?: NodeJS.ProcessEnv): { code: number | null; stdout: string } {
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env })
  return { code: result.status, stdout: result.stdout.trim() }
}

function start(command: string, env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn('/bin/sh', ['-c', command], { env })
  children.push(child)
  return child
}

function line(child: ChildProcessWithoutNullStreams, expected: string): Promise<boolean> {
  return new Promise((resolve) => {
    let out = ''
    const onData = (chunk: Buffer): void => {
      out += chunk.toString()
      if (out.split('\n').includes(expected)) {
        child.stdout.off('data', onData)
        resolve(true)
      }
    }
    child.stdout.on('data', onData)
    child.once('exit', () => resolve(out.split('\n').includes(expected)))
  })
}

function exited(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

async function holdLock(lock: string): Promise<ChildProcessWithoutNullStreams> {
  return holdLockAs(lock, first)
}

async function holdLockAs(
  lock: string,
  owner: typeof first
): Promise<ChildProcessWithoutNullStreams> {
  const holder = start(installLockHolderCommand(lock, owner))
  expect(await line(holder, 'HOLDER_READY')).toBe(true)
  holder.stdin.write('mark\n')
  expect(await line(holder, 'HOLDER_HELD')).toBe(true)
  return holder
}

const probe = (lock: string): string => sh(installLockHolderExitedProbeCommand(lock, OWNER)).stdout

function stealAs(
  lock: string,
  seen: ReturnType<typeof parseInstallLockHolderExit>,
  staleAfterSeconds = 20 * 60
): string {
  return sh(
    tryStealInstallLockCommand(host, lock, staleAfterSeconds, second, undefined, seen ?? undefined)
  ).stdout
}

describe.skipIf(!hasFlock)('flock-backed install lock, run for real', () => {
  it('keeps a live holder from being taken over, then reclaims it once the holder exits', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = await holdLock(lock)
    expect(readFileSync(join(lock, INSTALL_LOCK_HOLDER_FILENAME), 'utf8')).toBe('held')
    expect(probe(lock)).toBe('')
    // Even a forged proof cannot take a lock whose holder still holds it.
    const lockKey = sh(`stat -c %Y:%i '${lock}'`).stdout
    expect(stealAs(lock, { dirKey: lockKey, token: 't-first' })).toBe('BUSY')

    holder.stdin.end()
    expect(await exited(holder)).toBe(0)
    const seen = parseInstallLockHolderExit(probe(lock))
    expect(seen).toEqual({ dirKey: lockKey, token: 't-first' })
    expect(stealAs(lock, seen)).toBe('HOLDER_EXITED_OK')
    expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('t-second')
    // The successor's fresh lock is unmarked until its own holder marks it.
    expect(probe(lock)).toBe('')
  })

  it('treats a killed holder as gone', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = await holdLock(lock)
    holder.kill('SIGKILL')
    await exited(holder)
    expect(parseInstallLockHolderExit(probe(lock))?.token).toBe('t-first')
  })

  it('waits for a fenced command the dead owner left running', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = await holdLock(lock)
    const fence = installLockFenceStatement(lock, first)
    const straggler = start(`${fence} echo STARTED; sleep 2`)
    expect(await line(straggler, 'STARTED')).toBe(true)
    holder.stdin.end()
    await exited(holder)
    expect(probe(lock)).toBe('')
    expect(await exited(straggler)).toBe(0)
    expect(parseInstallLockHolderExit(probe(lock))).not.toBeNull()
  })

  it('fails a displaced owner fenced command', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = await holdLock(lock)
    expect(sh(`${installLockFenceStatement(lock, first)} echo RAN`).stdout).toBe('RAN')
    holder.stdin.end()
    await exited(holder)
    expect(stealAs(lock, parseInstallLockHolderExit(probe(lock)))).toBe('HOLDER_EXITED_OK')
    const late = sh(`${installLockFenceStatement(lock, first)} echo RAN`)
    expect(late).toEqual({ code: 75, stdout: '' })
  })

  it('never marks the lock when the desktop closes stdin before answering', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = start(installLockHolderCommand(lock, first))
    expect(await line(holder, 'HOLDER_READY')).toBe(true)
    holder.stdin.end()
    await exited(holder)
    expect(readFileSync(join(lock, INSTALL_LOCK_HOLDER_FILENAME), 'utf8')).toBe('')
    expect(probe(lock)).toBe('')
  })

  it('refuses to back a lock another owner holds', async () => {
    const lock = lockOwnedBy('t-other')
    const holder = start(installLockHolderCommand(lock, first))
    expect(await line(holder, 'HOLDER_READY')).toBe(false)
    expect(await exited(holder)).toBe(0)
  })

  it('lets only one of several concurrent contenders take a gone holder', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = await holdLock(lock)
    holder.stdin.end()
    await exited(holder)
    const seen = parseInstallLockHolderExit(probe(lock)) ?? undefined
    const command = tryStealInstallLockCommand(host, lock, 20 * 60, second, undefined, seen)
    const outputs = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<string>((resolve) => {
            let out = ''
            const child = start(command)
            child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
            child.once('exit', () => resolve(out.trim()))
          })
      )
    )
    expect(outputs.filter((output) => output === 'HOLDER_EXITED_OK')).toHaveLength(1)
  })

  it('keeps a fenced command own stderr', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = await holdLock(lock)
    const result = spawnSync(
      '/bin/sh',
      ['-c', `${installLockFenceStatement(lock, first)} echo oops >&2`],
      {
        encoding: 'utf8'
      }
    )
    expect(result.stderr.trim()).toBe('oops')
    holder.stdin.end()
  })

  it('leaves a live flock-backed lock to the age rules for a contender without proof', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = await holdLock(lock)
    holder.stdin.end()
    await exited(holder)
    // An older build sees only a fresh lock directory.
    expect(stealAs(lock, null)).toBe('BUSY')
  })

  it('leaves an unmarked lock to the age rules', () => {
    const lock = lockOwnedBy('t-first')
    expect(probe(lock)).toBe('')
    expect(stealAs(lock, null)).toBe('BUSY')
  })

  it('still takes a running holder lock by age, so a frozen window cannot block others', async () => {
    const lock = lockOwnedBy('t-first')
    await holdLock(lock)
    // -1 makes the lock stale by age.
    expect(stealAs(lock, null, -1)).toBe('OK')
    expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('t-second')
    expect(sh(`${installLockFenceStatement(lock, first)} echo RAN`).code).toBe(75)
  })

  it('clears the mark an unconfirmed holder left once it exits', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = await holdLock(lock)
    // Started before the holder sees EOF, so the unmark has to wait for it to exit.
    const unmark = start(installLockHolderUnmarkCommand(lock, first))
    holder.stdin.end()
    expect(await exited(unmark)).toBe(0)
    expect(readFileSync(join(lock, INSTALL_LOCK_HOLDER_FILENAME), 'utf8')).toBe('')
    expect(probe(lock)).toBe('')
  })

  it('gates the owner own lock removal on its fenced commands ending', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = await holdLock(lock)
    const straggler = start(`${installLockFenceStatement(lock, first)} echo STARTED; sleep 2`)
    expect(await line(straggler, 'STARTED')).toBe(true)
    holder.stdin.end()
    const removal = start(
      `${installLockReleaseGate(lock, first)} ${removeOwnedInstallLockCommand(host, lock, first)}`
    )
    // ast-grep-ignore: test-no-real-time-wait -- proves the real flock wait blocks the removal; there is no event to await.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(existsSync(lock)).toBe(true)
    expect(await exited(removal)).toBe(0)
    expect(existsSync(lock)).toBe(false)
  })

  // The gate's real flock wait gives up only after about 10 seconds of wall-clock time.
  it('fails the gated removal and keeps the lock while a fenced command outlives the wait', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = await holdLock(lock)
    const straggler = start(`${installLockFenceStatement(lock, first)} echo STARTED; sleep 30`)
    expect(await line(straggler, 'STARTED')).toBe(true)
    holder.stdin.end()
    const removal = start(
      `${installLockReleaseGate(lock, first)} ${removeOwnedInstallLockCommand(host, lock, first)}`
    )
    expect(await exited(removal)).toBe(1)
    expect(existsSync(lock)).toBe(true)
  }, 30_000)

  // The unmark kills only after its real flock wait of about 10 seconds.
  it('kills a holder that outlives the unmark wait, so it can never mark the lock late', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = start(installLockHolderCommand(lock, first))
    expect(await line(holder, 'HOLDER_READY')).toBe(true)
    // Its stdin stays open, so only the kill can end it.
    holder.stdin.write('mark\n')
    expect(await line(holder, 'HOLDER_HELD')).toBe(true)
    const unmark = start(installLockHolderUnmarkCommand(lock, first))
    expect(await exited(unmark)).toBe(0)
    expect(await exited(holder)).toBeNull()
    expect(readFileSync(join(lock, INSTALL_LOCK_HOLDER_FILENAME), 'utf8')).toBe('')
    expect(probe(lock)).toBe('')
  }, 30_000)

  // The unmark checks the pid only after its real flock wait of about 15 seconds.
  it('never kills a process that reused the holder pid', async () => {
    const lock = lockOwnedBy('t-first')
    const holder = await holdLock(lock)
    // A leftover fenced command keeps the lock busy past the unmark wait.
    const straggler = start(`${installLockFenceStatement(lock, first)} echo STARTED; sleep 30`)
    expect(await line(straggler, 'STARTED')).toBe(true)
    holder.stdin.end()
    await exited(holder)
    // The holder's pid now names a bystander, even one whose command line carries the token.
    const bystander = start('sleep 60; echo t-first')
    writeFileSync(join(lock, '.holder-pid'), String(bystander.pid))
    expect(await exited(start(installLockHolderUnmarkCommand(lock, first)))).toBe(0)
    expect(bystander.exitCode === null && bystander.signalCode === null).toBe(true)
    expect(straggler.exitCode === null && straggler.signalCode === null).toBe(true)
    expect(readFileSync(join(lock, INSTALL_LOCK_HOLDER_FILENAME), 'utf8')).toBe('')
  }, 30_000)

  it('ends the gated removal at once, keeping the lock, when it already names a successor', async () => {
    const lock = lockOwnedBy('t-second')
    const successor = await holdLockAs(lock, second)
    // Awaited, so the default 5 s test timeout fails a gate that sat out its 10 s wait.
    const removal = start(
      `${installLockReleaseGate(lock, first)} ${removeOwnedInstallLockCommand(host, lock, first)}`
    )
    expect(await exited(removal)).toBe(0)
    expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('t-second')
    successor.stdin.end()
  })

  it('degrades to an unbacked lock where flock is missing', async () => {
    const lock = lockOwnedBy('t-first')
    const bin = join(lock, '..', 'bin')
    mkdirSync(bin)
    const cat = sh('command -v cat').stdout
    symlinkSync(cat, join(bin, 'cat'))
    const holder = start(installLockHolderCommand(lock, first), { PATH: bin })
    expect(await line(holder, 'HOLDER_READY')).toBe(false)
    expect(await exited(holder)).toBe(0)
  })
})

describe('lock ownership check', () => {
  it('answers OWNED only for the token the lock names', () => {
    const lock = lockOwnedBy('t-first')
    expect(sh(installLockOwnedByCommand(lock, first)).stdout).toBe('OWNED')
    expect(sh(installLockOwnedByCommand(lock, second)).stdout).toBe('NOT_OWNED')
    expect(sh(installLockOwnedByCommand(join(lock, 'gone'), first)).stdout).toBe('NOT_OWNED')
  })
})

describe('steal without a holder proof', () => {
  it('carries no flock clauses, as on SSH and in older builds', () => {
    const lock = '/l/.install-lock'
    expect(tryStealInstallLockCommand(host, lock, 20 * 60, second)).not.toMatch(/holder|flock/u)
    const proofWithoutOwner = { dirKey: '1:2', token: 't-first' }
    expect(
      tryStealInstallLockCommand(host, lock, 20 * 60, undefined, undefined, proofWithoutOwner)
    ).not.toMatch(/holder|flock/u)
  })
})
