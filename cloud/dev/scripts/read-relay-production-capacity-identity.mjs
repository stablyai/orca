import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const CAPACITY_IDENTITY_NAME = 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT'

export function readProductionCapacityIdentity(revision) {
  const env = revision?.spec?.containers?.[0]?.env
  if (!Array.isArray(env)) throw new Error('director revision environment is missing')
  const matches = env.filter((entry) => entry?.name === CAPACITY_IDENTITY_NAME)
  if (matches.length === 0) return null
  if (matches.length !== 1) throw new Error('duplicate capacity identity')
  const value = matches[0]?.value
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('capacity identity is not a literal string')
  }
  return value
}

export function main() {
  const revision = JSON.parse(readFileSync(0, 'utf8'))
  process.stdout.write(`${JSON.stringify(readProductionCapacityIdentity(revision))}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
