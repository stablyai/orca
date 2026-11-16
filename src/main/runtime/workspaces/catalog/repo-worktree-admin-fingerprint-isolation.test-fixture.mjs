import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('.', process.argv[2])))
const keepAlive = setInterval(() => {}, 1_000)
const loaded = await import(process.argv[2])
const { readRepoWorktreeAdminFingerprint } = loaded.default ?? loaded
const directory = process.argv[3]
const fingerprints = await Promise.all(
  ['a', 'b', 'c', 'd'].map((name) => readRepoWorktreeAdminFingerprint(join(directory, name)))
)
const entries = await readdir(directory)
console.log(
  JSON.stringify({
    fingerprints: fingerprints.map((value) => (typeof value === 'symbol' ? 'unavailable' : value)),
    entries: entries.sort()
  })
)
clearInterval(keepAlive)
