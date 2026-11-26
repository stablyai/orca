#!/usr/bin/env node
import { openSync, closeSync, readSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runProcessSync } from '@orca/process-host'
import { resolve } from 'node:path'
import {
  handoffIsDirty,
  combineHandoffPatches,
  handoffWriteRecovery
} from './commander-handoff-changes.mjs'
import { stageOnHandoffBase, withHandoffIndexes } from './commander-handoff-base.mjs'

const usage = `orca-commander-handoff save <task> <progress.json> [--include-tracked-edits]
orca-commander-handoff read <task>
orca-commander-handoff publish <task> <remote-name> [--include-tracked-edits]
orca-commander-handoff restore <task> <remote-name>
orca-commander-handoff apply <task>

Run inside the project's Git checkout. The JSON file requires goal and next (text)
and optionally completed, checks, decisions and blockers (arrays of text).
Only publish and restore contact a remote. Publish shares the record, its base
commit (including unpushed committed history), and prior handoffs with readers
of that repository. Publishing handoff patches requires --include-tracked-edits. Restore leaves the worktree untouched.
Apply stages the saved tracked edits on a clean matching base commit. Untracked
files and changes inside submodules are excluded. Capturing a patch requires
one final version per path. Stage or preserve any mixed staged and unstaged
versions separately. The patch limit is 8 MiB.`
const sizeLimit = 65536

function runGit(args, input, { bytes = false, absentCode, env } = {}) {
  const result = runProcessSync({
    program: 'git',
    args,
    env,
    input,
    maxOutputBytes: bytes ? 8 * 1024 * 1024 : sizeLimit * 2,
    captureStdoutAsBytes: bytes,
    timeoutMs: 60000
  })
  if (result.code !== 0 && result.code !== absentCode) {
    throw new Error(result.stderr.trim() || 'Git operation failed')
  }
  return result
}

function git(args, input) {
  return runGit(args, input).stdout.trim()
}

function gitBytes(args) {
  return runGit(args, undefined, { bytes: true }).stdoutBytes
}

function gitIfPresent(args) {
  const result = runGit(args, undefined, { absentCode: 1 })
  return result.code === 1 ? null : result.stdout.trim()
}

function checkoutTarget(expected) {
  const cwd = git(['rev-parse', '--show-toplevel'])
  const index = resolve(git(['rev-parse', '--git-path', 'index']))
  const worktreeIndex = process.env.GIT_INDEX_FILE
    ? resolve(git(['rev-parse', '--git-dir']), 'index')
    : index
  return { cwd, index, worktreeIndex, expected }
}

function progress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object')
  }
  const record = {}
  for (const key of ['goal', 'next']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      throw new Error(`Expected text for ${key}`)
    }
    record[key] = value[key]
  }
  for (const key of ['completed', 'checks', 'decisions', 'blockers']) {
    const items = value[key] ?? []
    if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) {
      throw new Error(`Expected text array for ${key}`)
    }
    record[key] = items
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(record, key)) {
      throw new Error(`Unrecognized progress field: ${key}`)
    }
  }
  return record
}

function loadInput(file) {
  const fd = openSync(file, 'r')
  try {
    const bytes = Buffer.alloc(sizeLimit + 1)
    let len = 0
    while (len < bytes.length) {
      const count = readSync(fd, bytes, len, bytes.length - len)
      if (!count) {
        break
      }
      len += count
    }
    if (len > sizeLimit) {
      throw new Error('Progress record exceeds 64 KiB')
    }
    return progress(JSON.parse(bytes.toString('utf8', 0, len)))
  } finally {
    closeSync(fd)
  }
}

function readRecord(revision, task) {
  const data = JSON.parse(git(['cat-file', 'blob', `${revision}:handoff.json`]))
  if (
    data.version !== 1 ||
    data.task !== task ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(data.commit) ||
    typeof data.dirty !== 'boolean' ||
    typeof data.savedAt !== 'string'
  ) {
    throw new Error('Incompatible handoff record')
  }
  return {
    version: 1,
    task,
    commit: data.commit,
    dirty: data.dirty,
    hasTrackedEdits: Boolean(git(['ls-tree', revision, '--', ':(top)tracked.patch'])),
    savedAt: data.savedAt,
    progress: progress(data.progress)
  }
}

function captureTrackedPatch(cwd, head) {
  const args = [
    '-c',
    'diff.relative=false',
    'diff',
    '--no-color',
    '--binary',
    '--full-index',
    '--unified=3',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--ignore-submodules=all'
  ]
  const staged = gitBytes([...args, '--cached', head, '--', ':/'])
  const unstaged = gitBytes([...args, '--', ':/'])
  return combineHandoffPatches(cwd, staged, unstaged)
}

async function saveHandoff({
  task,
  head,
  ref,
  prior,
  expected,
  savedProgress,
  includeTrackedEdits
}) {
  const target = checkoutTarget(head)
  const capture = async (signal) => {
    const dirty = await handoffIsDirty(target)
    const patch = includeTrackedEdits ? captureTrackedPatch(target.cwd, head) : undefined
    const data = {
      version: 1,
      task,
      commit: head,
      dirty: dirty || Boolean(patch?.length),
      savedAt: new Date().toISOString(),
      progress: savedProgress
    }
    const blob = git(['hash-object', '-w', '--stdin'], JSON.stringify(data))
    let entries = `100644 blob ${blob}\thandoff.json\n`
    if (patch?.length) {
      const patchId = git(['hash-object', '-w', '--stdin'], patch)
      entries += `100644 blob ${patchId}\ttracked.patch\n`
    }
    const tree = git(['mktree'], entries)
    // Keep the first-parent chain for handoffs and the second parent for source history.
    const history =
      prior ?? git(['commit-tree', git(['mktree'], ''), '-m', 'Start Orca handoff history'])
    const revision = git([
      'commit-tree',
      tree,
      '-p',
      history,
      '-p',
      head,
      '-m',
      `Orca handoff for ${task}`
    ])
    // Compare HEAD and the old handoff in the same ref transaction.
    signal?.throwIfAborted()
    git(['update-ref', '--stdin'], `verify HEAD ${head}\nupdate ${ref} ${revision} ${expected}\n`)
  }
  return includeTrackedEdits ? withHandoffIndexes(target, capture) : capture()
}

async function main([action, task, arg, ...extra]) {
  if (action === '--help' || action === '-h') {
    return console.log(usage)
  }
  if (
    !['save', 'read', 'publish', 'restore', 'apply'].includes(action) ||
    (extra.length > 0 &&
      (extra.length !== 1 ||
        extra[0] !== '--include-tracked-edits' ||
        !['save', 'publish'].includes(action))) ||
    (['read', 'apply'].includes(action) ? arg !== undefined : !arg)
  ) {
    throw new Error(usage)
  }
  if (!task || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(task)) {
    throw new Error('Use a task name with letters, digits, hyphens or underscores')
  }
  const ref = `refs/orca/handoffs/${task}`
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}'])
  const prior = gitIfPresent(['rev-parse', '--verify', '--quiet', ref])
  const expected = prior ?? '0'.repeat(head.length)
  if (action === 'save') {
    await saveHandoff({
      task,
      head,
      ref,
      prior,
      expected,
      savedProgress: loadInput(arg),
      includeTrackedEdits: extra.length > 0
    })
  }
  if (action === 'publish' || action === 'restore') {
    if (!/^[\w][\w./-]*$/.test(arg) || !git(['remote']).split(/\r?\n/).includes(arg)) {
      throw new Error('Specify a configured Git remote by name')
    }
    const shared = `refs/heads/orca-handoff/${task}`
    if (action === 'publish') {
      if (!prior) {
        throw new Error('Save or restore this task before publishing')
      }
      if (
        !extra.length &&
        git(['rev-list', '--first-parent', '-1', prior, '--', ':(top)tracked.patch'])
      ) {
        throw new Error(
          'Handoff history contains code changes. Review and publish with --include-tracked-edits.'
        )
      }
      const record = readRecord(prior, task)
      if (!gitIfPresent(['rev-parse', '--verify', '--quiet', `${record.commit}^{commit}`])) {
        throw new Error(
          `This legacy handoff is missing base ${record.commit}. Republish from a checkout containing that commit.`
        )
      }
      let publication = prior
      if (gitIfPresent(['merge-base', '--is-ancestor', record.commit, prior]) === null) {
        // A legacy checkpoint may name a local commit without retaining it as a Git parent.
        const tree = git(['rev-parse', `${prior}^{tree}`])
        publication = git([
          'commit-tree',
          tree,
          '-p',
          prior,
          '-p',
          record.commit,
          '-m',
          `Preserve base for ${task}`
        ])
        git(['update-ref', ref, publication, prior])
      }
      git(['push', '--no-follow-tags', '--recurse-submodules=no', arg, `${publication}:${shared}`])
      return console.log(`Published ${task} to ${arg} at ${publication}`)
    }
    const incoming = `refs/orca/incoming/${randomUUID()}`
    try {
      git(['fetch', '--no-tags', '--recurse-submodules=no', arg, `${shared}:${incoming}`])
      const revision = git(['rev-parse', '--verify', `${incoming}^{commit}`])
      readRecord(revision, task)
      if (prior && gitIfPresent(['merge-base', '--is-ancestor', prior, revision]) === null) {
        throw new Error(
          'Local handoff has unpublished changes. Restore in another clone to compare.'
        )
      }
      git(['update-ref', ref, revision, expected])
    } finally {
      git(['update-ref', '-d', incoming])
    }
  }
  const revision = git(['rev-parse', '--verify', ref])
  const record = readRecord(revision, task)
  if (action === 'apply') {
    if (!record.hasTrackedEdits) {
      throw new Error('Handoff contains no tracked edits')
    }
    if (record.commit !== head) {
      throw new Error(`Check out the handoff base ${record.commit} before applying`)
    }
    const target = checkoutTarget(record.commit)
    const patch = gitBytes(['cat-file', 'blob', `${revision}:tracked.patch`])
    await stageOnHandoffBase(target, (privateIndex, onWriteFailure) => {
      for (const args of [
        ['diff', '--cached', '--quiet', head],
        ['diff', '--quiet']
      ]) {
        if (runGit([...args, '--', ':/'], undefined, { absentCode: 1 }).code === 1) {
          throw new Error('Commit or stash tracked changes before applying')
        }
      }
      const flags = ['-C', target.cwd, 'apply', '--index', '--binary', '--whitespace=nowarn']
      const options = { env: { ...process.env, GIT_INDEX_FILE: privateIndex } }
      runGit([...flags, '--check', '-'], patch, options)
      onWriteFailure(handoffWriteRecovery(target, patch))
      runGit([...flags, '-'], patch, options)
    })
  }
  console.log(JSON.stringify({ ...record, matchesCheckoutCommit: head === record.commit }, null, 2))
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
