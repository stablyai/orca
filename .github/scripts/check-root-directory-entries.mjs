import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

function readRootEntries(sha) {
  // Why: a git pathname is arbitrary bytes, and 'utf8' folds every invalid
  // sequence to U+FFFD — that mangles the reported name and makes two different
  // entries compare equal, so a genuinely new one can slip past the Set below.
  // latin1 maps each byte to one code unit, so the bytes survive the round trip.
  const stdout = execFileSync('git', ['ls-tree', '-z', '--name-only', sha], {
    encoding: 'latin1',
    stdio: ['ignore', 'pipe', 'inherit']
  })
  return stdout.split('\0').filter(Boolean)
}

function checkRootDirectoryEntries(argv) {
  if (argv.length !== 2) {
    console.error(`Usage: ${process.argv[1]} <base-sha> <head-sha>`)
    return 2
  }

  const [baseSha, headSha] = argv
  const baseEntries = new Set(readRootEntries(baseSha))
  const blockedEntries = readRootEntries(headSha).filter((entry) => !baseEntries.has(entry))

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
