import { pathToFileURL } from 'node:url'

export function classifyStagingBootstrap({ c2Kind, c2Admission, c3Kind, c3Admission }) {
  for (const kind of [c2Kind, c3Kind]) {
    if (!['legacy', 'modern'].includes(kind)) throw new Error('bootstrap runtime kind is invalid')
  }
  for (const admission of [c2Admission, c3Admission]) {
    if (!['general', 'migration-only'].includes(admission)) {
      throw new Error('bootstrap admission is not recoverable')
    }
  }
  if (c2Kind === 'modern' && c3Kind === 'modern') return 'complete'
  if (c2Kind === 'modern') return 'roll-c3'
  if (c3Kind === 'modern') return 'roll-c2'
  if (c2Admission === 'general') return 'normalize-and-roll-both'
  if (c3Admission === 'general') return 'resume-c2-then-c3'
  throw new Error('bootstrap has no general fallback')
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  return {
    c2Kind: values['c2-kind'],
    c2Admission: values['c2-admission'],
    c3Kind: values['c3-kind'],
    c3Admission: values['c3-admission']
  }
}

export function main(argv = process.argv.slice(2)) {
  process.stdout.write(`${classifyStagingBootstrap(parseArguments(argv))}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
