#!/usr/bin/env node

const args = process.argv.slice(2)
const first = args[0]

if (!first || first === '--help' || first === '-h') {
  process.argv = [process.argv[0], process.argv[1], 'mission', 'start', '--help']
} else if (first.startsWith('-')) {
  console.error('orca-sub: first argument must be the natural-language mission context.')
  process.exit(2)
} else {
  process.argv = [
    process.argv[0],
    process.argv[1],
    'mission',
    'start',
    '--text',
    first,
    ...args.slice(1)
  ]
}

await import('./orca-dev.mjs')
