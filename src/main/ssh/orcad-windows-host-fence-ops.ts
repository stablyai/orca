/**
 * The activation fence's ownership check and conditional release inside the Windows host script,
 * matching the POSIX guard in `orcad-activation-fence-scope.ts`, and the exited-own-lock check of
 * `orcad-exited-own-lock.ts`.
 */
import {
  ORCAD_FENCE_LOST_EXIT,
  ORCAD_FENCE_LOST_MARKER,
  ORCAD_FENCE_OWNER_FILENAME
} from './orcad-activation-fence-scope'
import { ORCAD_EXITED_OWN_LOCK_QUIET_SECONDS } from './orcad-state-snapshot-members'

export const ORCAD_WINDOWS_FENCE_ARG = '--fence'

const text = JSON.stringify

/** Strips `--fence <lockDir> <token>` and exits before the op unless the token is still ours. */
export const ORCAD_WINDOWS_FENCE_PRELUDE = `
function fenceOwner(lockDir) {
  try { return fs.readFileSync(path.join(lockDir, ${text(ORCAD_FENCE_OWNER_FILENAME)}), 'utf8') } catch { return null }
}
// The token this op runs under; null outside a fence, so nothing refreshes a fence it does not own.
let FENCE_TOKEN = null
let FENCE_DIR = null
function fencedArgv(argv) {
  if (argv[0] !== ${text(ORCAD_WINDOWS_FENCE_ARG)}) return argv
  FENCE_DIR = argv[1]
  FENCE_TOKEN = argv[2]
  if (fenceOwner(argv[1]) !== argv[2]) {
    process.stdout.write(${text(`${ORCAD_FENCE_LOST_MARKER}\n`)}, () => process.exit(${ORCAD_FENCE_LOST_EXIT}))
    return ['fence-lost']
  }
  return argv.slice(3)
}
`

export const ORCAD_WINDOWS_HOST_FENCE_OPS = `
Object.assign(ops, {
  'fence-lost'() {},
  'fence-check'() {
    answer('OK')
  },
  // Each piece is renamed aside and kept only if it is ours, else put straight back, so a release
  // that stalls after its token check never deletes a successor's journal or lock.
  'fence-release'(lockDir, journal, token) {
    if (fenceOwner(lockDir) !== token) return answer('SUPERSEDED')
    const journalAside = journal + '.release.' + process.pid
    let moved = false
    try { fs.renameSync(journal, journalAside); moved = true } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (moved) {
      const ours = fs.readFileSync(journalAside, 'utf8').includes(${text(`"fenceToken": `)} + JSON.stringify(token))
      if (!ours && !fs.existsSync(journal)) fs.renameSync(journalAside, journal)
      fs.rmSync(journalAside, { force: true })
    }
    const lockAside = lockDir + '.released.' + process.pid
    fs.renameSync(lockDir, lockAside)
    if (fenceOwner(lockAside) === token) fs.rmSync(lockAside, { recursive: true, force: true, maxRetries: 5 })
    else if (!fs.existsSync(lockDir)) fs.renameSync(lockAside, lockDir)
    try { fs.rmdirSync(path.dirname(lockDir)) } catch {}
    answer('RELEASED')
  },
  // Read-only: names which of \`tokens\` (clients proven exited) the lock holds, once it is quiet
  // and, with guardArg '1', no state-mutation lock exists.
  // The steal then takes the lock under its own arbitration, so nothing here writes.
  'fence-exited-owner'(lockDir, guardArg, ...tokens) {
    const quiet = (target) => Date.now() - (lstatOrNull(target)?.mtimeMs ?? Date.now()) > ${ORCAD_EXITED_OWN_LOCK_QUIET_SECONDS * 1000}
    const token = fenceOwner(lockDir)
    if (!tokens.includes(token) || !quiet(lockDir)) return answer('KEPT')
    // Any mutation lock refuses, as the steal does: it can only take an absent one.
    if (guardArg === '1' && lstatOrNull(MUTATION_LOCK)) return answer('KEPT')
    answer('EXITED_OWNER ' + token)
  }
})
`
