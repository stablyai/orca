#!/usr/bin/env bun
import { resolve } from 'node:path'
import { inspectAgentStorage } from '../../../src/main/native-chat/conversation-files/agent-storage-overview.ts'

export async function runAgentStorageOverview(args, output = console.log) {
  const value = args.indexOf('--state-directory')
  if (
    value === -1 ||
    !args[value + 1] ||
    args[value + 1].startsWith('--') ||
    args.some((arg, index) => index !== value + 1 && !['--state-directory', '--json'].includes(arg))
  ) {
    throw new Error('Usage: pnpm storage:overview --state-directory DIRECTORY [--json]')
  }
  const overview = await inspectAgentStorage(resolve(args[value + 1]))
  if (args.includes('--json')) {
    output(JSON.stringify(overview, null, 2))
    return
  }
  output('Read-only profile overview on this host; GB = 1,000,000,000 bytes.')
  output('Unique allocated GB | Referenced GB | Folder')
  for (const entry of overview.entries) {
    output(
      `${(entry.uniqueAllocatedBytes / 1e9).toFixed(3)} | ${(entry.referencedBytes / 1e9).toFixed(3)} | ${entry.name}${entry.skippedEntries ? ' (incomplete)' : ''}`
    )
  }
  output(
    `Profile unique total: ${(overview.totals.uniqueAllocatedBytes / 1e9).toFixed(3)} GB; skipped entries: ${overview.totals.skippedEntries}`
  )
  output(
    'Hardlinks are counted once per folder and once across the profile. Folder totals may overlap. APFS clone extents and links outside this profile are not measurable here; these are not reclaimable-space estimates.'
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  runAgentStorageOverview(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
