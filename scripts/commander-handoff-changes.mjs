import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess, runProcessSync } from '@orca/process-host'

export async function handoffIsDirty({ cwd, index }) {
  const result = await runProcess({
    program: 'git',
    cwd,
    env: { ...process.env, GIT_INDEX_FILE: index },
    args: ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    maxOutputBytes: 4096,
    timeoutMs: 60_000
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(result.stderr.trim() || 'Cannot read Git status')
  }
  return result.stdout.length > 0
}

// latin1 maps bytes one-to-one, so raw Git names remain distinct on POSIX.
function gitPathRows(options) {
  const result = runProcessSync({
    program: 'git',
    ...options,
    maxOutputBytes: 8 * 1024 * 1024,
    captureStdoutAsBytes: true
  })
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'Cannot inspect handoff paths')
  }
  return result.stdoutBytes.toString('latin1').split('\0').filter(Boolean)
}

function patchPaths(cwd, patch) {
  return gitPathRows({ cwd, args: ['apply', '--numstat', '-z', '-'], input: patch }).map((row) =>
    row.replace(/^[^\t]+\t[^\t]+\t/, '')
  )
}

export function combineHandoffPatches(cwd, staged, unstaged) {
  if (!staged.length) {
    return unstaged
  }
  if (!unstaged.length) {
    return staged
  }
  if (staged.length + unstaged.length > 8 * 1024 * 1024) {
    throw new Error('Tracked patches exceed the 8 MiB limit')
  }
  const stagedPaths = new Set(patchPaths(cwd, staged))
  if (patchPaths(cwd, unstaged).some((file) => stagedPaths.has(file))) {
    throw new Error(
      'A path has both staged and unstaged changes. Stage its final contents or save the staged version separately before capturing tracked edits.'
    )
  }
  return Buffer.concat([staged, unstaged])
}

function decodedPath(raw) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    Buffer.from(raw, 'latin1')
  )
}

function inspectCheckout(failure) {
  return new Error(
    `${failure.message}\nRun git -c core.quotePath=true status --short from the repository root to inspect changes before retrying.`,
    { cause: failure }
  )
}

// A checked patch cannot add a file over a pre-existing untracked file.
// Remember which paths were absent so recovery can name only newly created ones.
export function handoffWriteRecovery({ cwd, index }, patch) {
  let paths, absent
  const exists = (file) => lstatSync(join(cwd, file), { throwIfNoEntry: false })
  try {
    paths = new Set(patchPaths(cwd, patch))
    absent = [...paths].map(decodedPath).filter((file) => !exists(file))
  } catch {
    return inspectCheckout
  }
  return (failure) => {
    const message = [failure.message]
    try {
      const changed = gitPathRows({
        cwd,
        env: { ...process.env, GIT_INDEX_FILE: index },
        args: [
          '--no-optional-locks',
          'diff',
          '--no-ext-diff',
          '--no-renames',
          '--name-only',
          '-z',
          '--'
        ]
      })
      const tracked = changed.filter((file) => paths.has(file)).map(decodedPath)
      const added = absent.filter(exists)
      if (tracked.length || added.length) {
        message.push(
          'The handoff write stopped before the index was published. Review these paths from the repository root before retrying.'
        )
      }
      if (tracked.length) {
        message.push(
          'Changed tracked paths (restore each with git --literal-pathspecs restore --worktree -- <path>):',
          tracked.map((file) => JSON.stringify(file)).join('\n')
        )
      }
      if (added.length) {
        message.push(
          'New paths (move each file aside before retrying):',
          added.map((file) => JSON.stringify(file)).join('\n')
        )
      }
    } catch {
      return inspectCheckout(failure)
    }
    return new Error(message.join('\n'), { cause: failure })
  }
}
