/**
 * The host script's state ops on Windows: the pre-activation snapshot, its comparison and
 * restore, the newest-write probe, and the first-activation owner admission.
 *
 * Same contract and tokens as the POSIX commands in `orcad-state-snapshot.ts` and
 * `orcad-initial-activation-admission.ts`. The snapshot is a directory copy (`state/`) rather
 * than a tar: there is no tar in Node, and spawning `tar.exe` would be a second process. It is
 * built under a partial name and renamed into place, so a half-written snapshot is never
 * `PRESENT`. Symlinks and junctions anywhere in captured state fail closed, as on POSIX.
 */
import { PRIMARY_RUNTIME_METADATA_FILE } from '../../shared/runtime-bootstrap'
import { ORCAD_LOCK_FILE_NAME } from '../orcad/orcad-instance-lock'
import {
  ORCAD_SNAPSHOT_MEMBERS,
  ORCAD_STATE_RESTORE_STAGE_DIRNAME,
  ORCAD_WINDOWS_SNAPSHOT_STATE_DIRNAME
} from './orcad-state-snapshot-members'

export type OrcadWindowsHostStateOp =
  | 'snapshot-capture'
  | 'snapshot-probe'
  | 'snapshot-restore'
  | 'snapshot-clear'
  | 'snapshot-compare'
  | 'state-newest-mtime'
  | 'owner-admission'

const OWNER_RECORD_MAX_BYTES = 64 * 1024
const text = JSON.stringify

/** Evaluated inside the host script, after `fs`, `path`, `answer` and `ops` exist. */
export const ORCAD_WINDOWS_HOST_STATE_OPS = `
const MEMBERS = ${text(ORCAD_SNAPSHOT_MEMBERS)}
const STATE_DIR = ${text(ORCAD_WINDOWS_SNAPSHOT_STATE_DIRNAME)}
const RESTORE_STAGE = ${text(ORCAD_STATE_RESTORE_STAGE_DIRNAME)}

function lstatOrNull(target) {
  try { return fs.lstatSync(target) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

// Node reports junctions as symbolic links too, so one check covers both.
function treeHasLink(target) {
  const stats = fs.lstatSync(target)
  if (stats.isSymbolicLink()) return true
  if (!stats.isDirectory()) return false
  return fs.readdirSync(target).some((name) => treeHasLink(path.join(target, name)))
}

function treesEqual(left, right) {
  const a = lstatOrNull(left)
  const b = lstatOrNull(right)
  if (!a || !b) return !a && !b
  if (a.isSymbolicLink() || b.isSymbolicLink()) throw new Error('link in state')
  if (a.isDirectory() !== b.isDirectory()) return false
  if (!a.isDirectory()) return a.size === b.size && fs.readFileSync(left).equals(fs.readFileSync(right))
  const names = fs.readdirSync(left).sort()
  const other = fs.readdirSync(right).sort()
  return names.length === other.length && names.every((name, index) => name === other[index] && treesEqual(path.join(left, name), path.join(right, name)))
}

function newestMtime(target) {
  const stats = lstatOrNull(target)
  if (!stats || stats.isSymbolicLink()) return null
  if (!stats.isDirectory()) return stats.mtimeMs
  return fs.readdirSync(target).reduce((newest, name) => {
    const value = newestMtime(path.join(target, name))
    return value === null || (newest !== null && newest >= value) ? newest : value
  }, null)
}

function renameWithRetry(from, to) {
  for (const delay of [0, 50, 100, 150, 200, 250]) {
    if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    try { fs.renameSync(from, to); return } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || delay === 250) throw error
    }
  }
}

const removeTree = (target) => fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 })

Object.assign(ops, {
  'snapshot-capture'(root, snapshotDir) {
    let present
    try {
      present = MEMBERS.filter((member) => lstatOrNull(path.join(root, member)))
      if (present.some((member) => treeHasLink(path.join(root, member)))) return answer('FAILED')
    } catch { return answer('FAILED') }
    if (present.length === 0) return answer('EMPTY')
    const partial = path.join(snapshotDir, STATE_DIR + '.partial-' + process.pid)
    try {
      removeTree(partial)
      fs.mkdirSync(partial, { recursive: true })
      for (const member of present) {
        fs.cpSync(path.join(root, member), path.join(partial, member), { recursive: true, errorOnExist: true })
      }
      removeTree(path.join(snapshotDir, STATE_DIR))
      renameWithRetry(partial, path.join(snapshotDir, STATE_DIR))
    } catch {
      try { removeTree(partial) } catch {}
      return answer('FAILED')
    }
    answer('CAPTURED')
  },

  'snapshot-probe'(snapshotDir) {
    let stats
    try { stats = lstatOrNull(path.join(snapshotDir, STATE_DIR)) } catch { return answer('UNKNOWN') }
    answer(stats && stats.isDirectory() ? 'PRESENT' : 'ABSENT')
  },

  // Copy into a stage first, so an unreadable snapshot fails before live state is touched.
  'snapshot-restore'(root, snapshotDir) {
    const state = path.join(snapshotDir, STATE_DIR)
    const stats = lstatOrNull(state)
    if (!stats || !stats.isDirectory()) return answer('MISSING')
    const stage = path.join(root, RESTORE_STAGE)
    try {
      fs.mkdirSync(root, { recursive: true })
      removeTree(stage)
      fs.cpSync(state, stage, { recursive: true })
      if (!MEMBERS.some((member) => lstatOrNull(path.join(stage, member)))) {
        removeTree(stage)
        return answer('FAILED')
      }
    } catch {
      try { removeTree(stage) } catch {}
      return answer('FAILED')
    }
    try {
      for (const member of MEMBERS) removeTree(path.join(root, member))
      for (const member of MEMBERS) {
        if (lstatOrNull(path.join(stage, member))) renameWithRetry(path.join(stage, member), path.join(root, member))
      }
      removeTree(stage)
    } catch { return answer('FAILED') }
    answer('RESTORED')
  },

  'snapshot-clear'(root) {
    try {
      fs.mkdirSync(root, { recursive: true })
      for (const member of MEMBERS) removeTree(path.join(root, member))
    } catch { return answer('FAILED') }
    answer('RESTORED')
  },

  'snapshot-compare'(root, snapshotDir) {
    try {
      const rootStats = lstatOrNull(root)
      const state = path.join(snapshotDir, STATE_DIR)
      const stateStats = lstatOrNull(state)
      if (!rootStats || !rootStats.isDirectory() || !stateStats || !stateStats.isDirectory()) return answer('UNKNOWN')
      if (treeHasLink(state)) return answer('UNKNOWN')
      for (const member of MEMBERS) {
        const live = path.join(root, member)
        if (lstatOrNull(live) && treeHasLink(live)) return answer('UNKNOWN')
        if (!treesEqual(live, path.join(state, member))) return answer('CHANGED')
      }
    } catch { return answer('UNKNOWN') }
    answer('UNCHANGED')
  },

  'state-newest-mtime'(root) {
    let newest = null
    try {
      for (const member of MEMBERS) {
        const value = newestMtime(path.join(root, member))
        if (value !== null && (newest === null || value > newest)) newest = value
      }
    } catch { return answer('UNKNOWN') }
    answer(newest === null ? 'UNKNOWN' : String(Math.floor(newest / 1000)))
  },

  // A live, unreadable or unexpected owner record defers the first activation.
  'owner-admission'(userDataDir) {
    const owners = ${text([ORCAD_LOCK_FILE_NAME, PRIMARY_RUNTIME_METADATA_FILE])}
    for (const name of owners) {
      const file = path.join(userDataDir, name)
      let pid
      try {
        const stats = lstatOrNull(file)
        if (!stats) continue
        if (!stats.isFile() || stats.size > ${OWNER_RECORD_MAX_BYTES}) return answer('UNVERIFIABLE ' + name)
        pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid
      } catch { return answer('UNVERIFIABLE ' + name) }
      if (!Number.isSafeInteger(pid) || pid <= 0) return answer('UNVERIFIABLE ' + name)
      try { process.kill(pid, 0); return answer('LIVE ' + name + ' ' + pid) } catch (error) {
        if (error.code === 'EPERM') return answer('LIVE ' + name + ' ' + pid)
        if (error.code !== 'ESRCH') return answer('UNVERIFIABLE ' + name)
      }
    }
    answer('CLEAR')
  }
})
`
