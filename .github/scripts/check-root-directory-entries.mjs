import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

function readRootEntries(sha) {
  // Why: a git pathname is arbitrary bytes, and 'utf8' folds every invalid
  // sequence to U+FFFD — that mangles the reported name and makes two different
  // entries compare equal, so a genuinely new one can slip past the comparison below.
  // latin1 maps each byte to one code unit, so the bytes survive the round trip.
  const stdout = execFileSync('git', ['ls-tree', '-z', sha], {
    encoding: 'latin1',
    stdio: ['ignore', 'pipe', 'inherit']
  })
  return new Map(
    stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('\t')
        return [entry.slice(separator + 1), entry.slice(0, separator).split(' ')[1]]
      })
  )
}

// Keep explicitly requested root additions allowed until the base tree carries them.
const REVIEWED_ROOT_ENTRIES = new Map([
  ['cloud', 'tree'],
  ['opencode.json', 'blob'],
  ['MERGE-CONFLICTS.md', 'blob']
])

function checkRootDirectoryEntries(argv) {
  if (argv.length !== 2) {
    console.error(`Usage: ${process.argv[1]} <base-sha> <head-sha>`)
    return 2
  }

  const [baseSha, headSha] = argv
  const baseEntries = readRootEntries(baseSha)
  const blockedEntries = [...readRootEntries(headSha)]
    .filter(([name, type]) => !baseEntries.has(name) && REVIEWED_ROOT_ENTRIES.get(name) !== type)
    .map(([name]) => name)

  if (blockedEntries.length === 0) {
    console.log('Root directory guard passed: no new root-level files or folders.')
    return 0
  }

  console.log(
    '::error title=Root-level additions blocked::New root-level files or folders bloat the GitHub landing page.'
  )
  console.log('Root directory guard failed.')
  console.log(
    'New root-level files or folders are not allowed because they bloat the GitHub landing page.'
  )
  console.log('Move each new entry under an existing top-level directory.')
  console.log('Blocked entries:')
  // Why: an entry name is attacker-controlled and may start with '::' (the runner
  // trims leading spaces before matching) or embed a newline, so printing it bare
  // lets a PR forge annotations. Fence the untrusted list with an unguessable
  // stop-commands token, and write the raw bytes rather than a re-encoded string.
  const resumeToken = randomUUID()
  console.log(`::stop-commands::${resumeToken}`)
  for (const entry of blockedEntries) {
    process.stdout.write(Buffer.from(`  ${entry}\n`, 'latin1'))
  }
  console.log(`::${resumeToken}::`)
  return 1
}

try {
  // Why: process.exit truncates a piped write part-way through on macOS, so set
  // exitCode and let node flush the blocked-entry list before it exits.
  process.exitCode = checkRootDirectoryEntries(process.argv.slice(2))
} catch (error) {
  // Why: git already reported the failure on the inherited stderr, so surface its
  // status rather than a node stack trace. Anything else is a real bug — rethrow.
  if (typeof error.status !== 'number') {
    throw error
  }
  process.exitCode = error.status
}
