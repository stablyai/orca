import { execFileSync } from 'node:child_process'

function readRootEntries(sha) {
  const stdout = execFileSync('git', ['ls-tree', '-z', '--name-only', sha], {
    encoding: 'utf8',
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
  for (const entry of blockedEntries) {
    console.log(`  ${entry}`)
  }
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
