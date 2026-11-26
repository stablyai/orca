import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { runProcessSync, spawnProcess } from '@orca/process-host'

// Attempt every owned lock even if removing one fails.
function releaseLocks(locks) {
  let firstError
  for (const lock of locks.toReversed()) {
    try {
      unlinkSync(lock)
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError) {
    throw firstError
  }
}

// Git 2.25 and 2.26 have only the files ref backend and no interactive prepare.
// Follow Git's lockfile convention for HEAD and each symbolic target (including
// packed branches, whose writers still lock the loose ref before changing it).
function withLegacyBase(cwd, expected, stage) {
  function git(args) {
    const result = runProcessSync({ program: 'git', cwd, args, timeoutMs: 15_000 })
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || 'Cannot read checkout base')
    }
    return result.stdout.trimEnd()
  }

  const locks = []
  try {
    let ref = 'HEAD'
    while (ref) {
      const path = resolve(cwd, git(['rev-parse', '--git-path', ref]))
      const lock = `${path}.lock`
      mkdirSync(dirname(lock), { recursive: true })
      closeSync(openSync(lock, 'wx'))
      locks.push(lock)
      const stat = lstatSync(path, { throwIfNoEntry: false })
      // Packed direct refs have no loose file.
      if (!stat) {
        break
      }
      if (stat.isSymbolicLink()) {
        ref = readlinkSync(path)
      } else {
        if (!stat.isFile() || stat.size > 4096) {
          throw new Error('Unexpected Git reference')
        }
        const contents = readFileSync(path, 'utf8').trimEnd()
        ref = contents.startsWith('ref:') ? contents.slice(4).trimStart() : null
      }
      if (ref) {
        git(['check-ref-format', ref])
      }
    }
    if (git(['rev-parse', '--verify', 'HEAD^{commit}']) !== expected) {
      throw new Error(`Check out the handoff base ${expected} before applying`)
    }
    stage()
  } finally {
    releaseLocks(locks)
  }
}

// Verifying HEAD locks both the worktree's HEAD and its branch. Git keeps
// these locks while our synchronous stage runs and releases them on abort/EOF.
async function withLockedHandoffBase(cwd, expected, signal, stage) {
  const env = { ...process.env, LC_ALL: 'C' }
  // Old Git buffers its entire stdin before parsing it, so probing interactively would deadlock.
  const probe = runProcessSync({
    program: 'git',
    args: ['update-ref', '--stdin'],
    cwd,
    env,
    input: 'start\nabort\n',
    timeoutMs: 15_000
  })
  if (probe.code !== 0) {
    if (probe.stderr.includes('unknown command: start')) {
      return withLegacyBase(cwd, expected, stage)
    }
    throw new Error(probe.stderr.trim() || 'Could not start Git reference transaction')
  }
  const child = spawnProcess({
    program: 'git',
    args: ['update-ref', '--stdin'],
    cwd,
    env,
    detached: process.platform !== 'win32'
  })
  let error = ''
  child.stderr.setEncoding('utf8').on('data', (data) => {
    error = (error + data).slice(-4096)
  })
  child.on('error', (err) => {
    error = err.message
  })
  child.stdin.on('error', (err) => {
    if (!error) {
      error = err.message
    }
  })
  const closed = new Promise((resolve) => child.once('close', resolve))
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const replies = lines[Symbol.asyncIterator]()
  let prepared = false
  const terminate = () => child.kill()
  const timeout = setTimeout(terminate, 60_000)
  signal.addEventListener('abort', terminate, { once: true })
  try {
    child.stdin.write(`start\nverify HEAD ${expected}\nprepare\n`)
    if (
      (await replies.next()).value === 'start: ok' &&
      (await replies.next()).value === 'prepare: ok'
    ) {
      prepared = true
      signal.throwIfAborted()
      stage()
    }
  } finally {
    child.stdin.end(prepared ? 'abort\n' : undefined)
    await closed
    clearTimeout(timeout)
    signal.removeEventListener('abort', terminate)
    lines.close()
  }
  if (!prepared) {
    signal.throwIfAborted()
    throw new Error(
      `Could not lock the handoff base ${expected}: ${error.trim() || 'Git transaction failed'}`
    )
  }
}

// Checkout writes the index and worktree before it updates HEAD. Hold the real
// index lock for the entire ref transaction, and publish our private index only
// after git apply has updated all patch paths successfully.
export async function stageOnHandoffBase({ cwd, index, worktreeIndex = index, expected }, apply) {
  const locks = []
  const privateIndex = `${index}.orca-${randomUUID()}`
  const controller = new AbortController()
  const interrupt = () => controller.abort(new Error('Handoff staging interrupted'))
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    for (const file of new Set([worktreeIndex, index])) {
      const lock = `${file}.lock`
      closeSync(openSync(lock, 'wx'))
      locks.push(lock)
    }
    try {
      copyFileSync(index, privateIndex, constants.COPYFILE_EXCL)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
    await withLockedHandoffBase(cwd, expected, controller.signal, () => {
      apply(privateIndex)
      renameSync(privateIndex, index)
    })
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    try {
      rmSync(privateIndex, { force: true })
      rmSync(`${privateIndex}.lock`, { force: true })
    } finally {
      releaseLocks(locks)
    }
  }
}
