/** Local stand-ins for a WSL guest: homes with or without a pinned Node, PATHs with a missing or crippled bash, and process-tree reads. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { quotePosixShell } from '../../shared/shell-argument-quoting'

function commandPath(name: string): string {
  return spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
}

export function bashSupportsRelay(): boolean {
  const probe = spawnSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], {
    encoding: 'utf8'
  })
  const [major, minor] = (probe.stdout ?? '').trim().split(' ').map(Number)
  return probe.status === 0 && (major > 4 || (major === 4 && minor >= 3))
}

export function guestHome(scratch: string, withRuntime: boolean): string {
  const dir = mkdtempSync(join(scratch, 'home-'))
  if (withRuntime) {
    const bin = join(dir, '.orca-remote', 'runtimes', 'node-abc', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(process.execPath, join(bin, 'node'))
  }
  return dir
}

/** A PATH with `cat` and `sed` but no `bash`. */
export function pathWithoutBash(scratch: string): string {
  const bin = mkdtempSync(join(scratch, 'bin-'))
  for (const name of ['cat', 'sed']) {
    symlinkSync(commandPath(name), join(bin, name))
  }
  return bin
}

/** A PATH whose `bash` runs the relay script through `sed`, standing in for an older or stripped build. */
export function pathWithEditedBash(scratch: string, sedExpression: string): string {
  const bin = pathWithoutBash(scratch)
  writeFileSync(
    join(bin, 'bash'),
    [
      '#!/bin/sh',
      `script=$(printf '%s' "$2" | sed -e ${quotePosixShell(sedExpression)})`,
      'shift 2',
      `exec ${quotePosixShell(commandPath('bash'))} -c "$script" "$@"`
    ].join('\n'),
    { mode: 0o755 }
  )
  return bin
}

/** Bash older than 4.3: the version gate must fail. */
export const OLD_BASH_EDIT = 's/BASH_VERSINFO\\[0\\]/4/g; s/BASH_VERSINFO\\[1\\]/2/g'
/** Bash built without network redirections opens /dev/tcp/... as a plain, missing file. */
export const NO_DEV_TCP_EDIT = 's|/dev/tcp/|/nonexistent-tcp/|g'

/** Every descendant of `rootPid`, including itself. */
export function processTree(rootPid: number): number[] {
  const rows = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout
  const parents = rows
    .trim()
    .split('\n')
    .map((row) => row.trim().split(/\s+/).map(Number))
  const tree = new Set([rootPid])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, parent] of parents) {
      if (tree.has(parent) && !tree.has(pid)) {
        tree.add(pid)
        grew = true
      }
    }
  }
  return [...tree]
}

export function treeRssMb(pids: readonly number[]): number {
  const out = spawnSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' }).stdout
  return out
    .trim()
    .split('\n')
    .reduce((sum, kb) => sum + Number(kb) / 1024, 0)
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
