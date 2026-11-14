#!/usr/bin/env node
import { resolve } from 'node:path'
import {
  inspectChatTemporaryStorage,
  sweepChatTemporaryStorage
} from '../../../src/main/native-chat/conversation-files/native-chat-temporary-storage.ts'

export async function runChatTemporaryStorage(args, output = console.log) {
  const apply = args.includes('--apply')
  const json = args.includes('--json')
  const value = args.indexOf('--state-directory')
  if (
    value === -1 ||
    !args[value + 1] ||
    args[value + 1].startsWith('--') ||
    args.some(
      (arg, index) =>
        index !== value + 1 && !['--apply', '--json', '--state-directory'].includes(arg)
    )
  ) {
    throw new Error('Usage: pnpm reclaim-chat-temp --state-directory DIRECTORY [--json] [--apply]')
  }
  const directory = resolve(args[value + 1])
  const entries = await inspectChatTemporaryStorage(directory)
  if (!json) {
    output(
      'Preview of managed temporary data on this host. Reports, provider history and legacy scratch are retained.'
    )
    for (const entry of entries) {
      output(
        `${entry.reason}: ${JSON.stringify(entry.path)} (${entry.allocatedBytes} allocated bytes observed)`
      )
    }
    output(
      'Sizes are unique within each scanned entry. Shared hardlinks/clones can reduce space actually reclaimed; protected entries may not be fully scanned.'
    )
    if (!apply) {
      output('No files removed. Add --apply to recheck and remove eligible entries.')
    }
  }
  if (apply) {
    const result = await sweepChatTemporaryStorage(directory)
    if (json) {
      output(JSON.stringify({ stateDirectory: directory, entries, result }, null, 2))
    } else {
      output(`Removed: ${result.removed}; failed: ${result.failed}`)
    }
    if (result.failed) {
      process.exitCode = 1
    }
  } else if (json) {
    output(JSON.stringify({ stateDirectory: directory, entries }, null, 2))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  runChatTemporaryStorage(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
