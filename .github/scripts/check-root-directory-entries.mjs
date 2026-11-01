import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

function readRootEntries(sha) {
  // Git paths are arbitrary bytes; latin1 round-trips them while utf8 merges invalid sequences into U+FFFD, hiding distinct entries.
  const stdout = execFileSync('git', ['ls-tree', '-z', '--name-only', sha], {
    encoding: 'latin1',
    stdio: ['ignore', 'pipe', 'inherit']
  })
  return stdout.split('\0').filter(Boolean)
}

// These reviewed additions stay listed until the base tree carries them.
const REVIEWED_ROOT_ENTRIES = new Set(['.claude', '.mcp.json', 'cloud', 'opencode.json'])

function checkRootDirectoryEntries(argv) {
  if (argv.length !== 2) {
    console.error(`Usage: ${process.argv[1]} <base-sha> <head-sha>`)
    return 2
  }

  const [baseSha, headSha] = argv
  const baseEntries = new Set(readRootEntries(baseSha))
  const blockedEntries = readRootEntries(headSha).filter(
    (entry) => !baseEntries.has(entry) && !REVIEWED_ROOT_ENTRIES.has(entry)
  )

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
  // Untrusted names can forge runner commands/newlines; fence them with a random stop-commands token and preserve raw bytes.
  const resumeToken = randomUUID()
  console.log(`::stop-commands::${resumeToken}`)
  for (const entry of blockedEntries) {
    process.stdout.write(Buffer.from(`  ${entry}\n`, 'latin1'))
  }
  console.log(`::${resumeToken}::`)
  return 1
}

try {
  // Let piped output flush; process.exit can truncate it on macOS.
  process.exitCode = checkRootDirectoryEntries(process.argv.slice(2))
} catch (error) {
  // Git already reported failures; preserve its exit status and rethrow other bugs.
  if (typeof error.status !== 'number') {
    throw error
  }
  process.exitCode = error.status
}
