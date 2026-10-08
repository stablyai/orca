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
import { ORCAD_WINDOWS_PROCESS_TREE_FILENAME } from '../../shared/orcad-artifacts'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { ORCAD_FENCE_LOST_EXIT, ORCAD_FENCE_LOST_MARKER } from './orcad-activation-fence-scope'
import {
  ORCAD_SNAPSHOT_MEMBERS,
  ORCAD_STATE_MUTATION_BUSY,
  ORCAD_STATE_MUTATION_FENCE_HEARTBEAT_SECONDS,
  ORCAD_STATE_MUTATION_LOCK_DIRNAME,
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
const MUTATION_LOCK = path.join(__dirname, ${text(ORCAD_STATE_MUTATION_LOCK_DIRNAME)})

// The fence goes stale by age; a live mutation keeps it fresh, and a dead process stops.
function refreshFence() {
  try {
    // Only the fence this op's run still owns: a superseded or foreign fence ages on its own.
    if (FENCE_TOKEN === null || !lstatOrNull(FENCE_DIR)?.isDirectory()) return
    if (fenceOwner(FENCE_DIR) !== FENCE_TOKEN) return
    const now = new Date()
    fs.utimesSync(FENCE_DIR, now, now)
  } catch {}
}

// A PID alone is no identity on Windows: PIDs are reused, and EPERM still means "some process".
let processTree
function processCreationTime(pid) {
  if (processTree === undefined) {
    processTree = null
    for (const name of fs.readdirSync(__dirname)) {
      if (!name.startsWith(${text(`${ORCAD_INSTALL_MODEL.dirPrefix}-`)})) continue
      try { processTree = require(path.join(__dirname, name, ${text(ORCAD_WINDOWS_PROCESS_TREE_FILENAME)})); break } catch {}
    }
  }
  try {
    const created = processTree?.getProcessCreationTime(pid)
    return typeof created === 'number' ? created : null
  } catch { return null }
}

// 'alive', 'dead', or 'unknown' when the creation time cannot be read.
function holderState(owner) {
  try { process.kill(owner.pid, 0) } catch (error) { if (error.code === 'ESRCH') return 'dead' }
  if (typeof owner.creationTimeMs !== 'number') return 'unknown'
  const created = processCreationTime(owner.pid)
  if (created === null) return 'unknown'
  return created === owner.creationTimeMs ? 'alive' : 'dead'
}

function readOwner() {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(MUTATION_LOCK, 'owner.json'), 'utf8'))
    return owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner : null
  } catch { return null }
}

function takeStateMutationLock() {
  try { fs.mkdirSync(MUTATION_LOCK) } catch (error) {
    if (error.code !== 'EEXIST') return false
    const owner = readOwner()
    const age = Date.now() - (lstatOrNull(MUTATION_LOCK)?.mtimeMs ?? 0)
    // No owner yet: no work began, and the owner write is exclusive, so a late writer backs off.
    const state = owner ? holderState(owner) : age > 60000 ? 'dead' : 'alive'
    // Only proof of exit frees it: a live pid whose identity is unknown may be a suspended run.
    if (state !== 'dead') return false
    try { removeTree(MUTATION_LOCK); fs.mkdirSync(MUTATION_LOCK) } catch { return false }
  }
  // Exclusive: a run that resumes after a takeover finds an owner already there and backs off.
  try {
    const owner = { pid: process.pid, creationTimeMs: processCreationTime(process.pid) }
    fs.writeFileSync(path.join(MUTATION_LOCK, 'owner.json'), JSON.stringify(owner), { flag: 'wx' })
    return true
  } catch { return false }
}

// One capture, restore or clear at a time: a client that stopped waiting has not stopped the
// last one, and a rerun beside it would mix two restores in one stage.
function withStateMutationLock(run) {
  return async (...opArgs) => {
    if (!takeStateMutationLock()) return answer(${text(ORCAD_STATE_MUTATION_BUSY)})
    // Rechecked once the lock is held: an exited-owner steal holds it across the fence takeover.
    if (FENCE_TOKEN !== null && fenceOwner(FENCE_DIR) !== FENCE_TOKEN) {
      try { removeTree(MUTATION_LOCK) } catch {}
      return process.stdout.write(${text(`${ORCAD_FENCE_LOST_MARKER}
`)}, () => process.exit(${ORCAD_FENCE_LOST_EXIT}))
    }
    let token = 'FAILED'
    // Why async ops: a synchronous copy would block this timer for the whole mutation.
    const beat = setInterval(refreshFence, ${ORCAD_STATE_MUTATION_FENCE_HEARTBEAT_SECONDS * 1000})
    try {
      refreshFence()
      token = await run(...opArgs)
    } catch {
      token = 'FAILED'
    } finally {
      clearInterval(beat)
      try { removeTree(MUTATION_LOCK) } catch {}
    }
    // Why after the finally: answer() exits the process, which would leak the lock.
    answer(token)
  }
}

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
const removeTreeAsync = (target) => fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5 })

Object.assign(ops, {
  'snapshot-capture': withStateMutationLock(async (root, snapshotDir) => {
    let present
    try {
      present = MEMBERS.filter((member) => lstatOrNull(path.join(root, member)))
      if (present.some((member) => treeHasLink(path.join(root, member)))) return ('FAILED')
    } catch { return ('FAILED') }
    if (present.length === 0) return ('EMPTY')
    const partial = path.join(snapshotDir, STATE_DIR + '.partial-' + process.pid)
    try {
      await removeTreeAsync(partial)
      fs.mkdirSync(partial, { recursive: true })
      for (const member of present) {
        await fs.promises.cp(path.join(root, member), path.join(partial, member), { recursive: true, errorOnExist: true })
      }
      await removeTreeAsync(path.join(snapshotDir, STATE_DIR))
      renameWithRetry(partial, path.join(snapshotDir, STATE_DIR))
    } catch {
      try { await removeTreeAsync(partial) } catch {}
      return ('FAILED')
    }
    return 'CAPTURED'
  }),

  'snapshot-probe'(snapshotDir) {
    let stats
    try { stats = lstatOrNull(path.join(snapshotDir, STATE_DIR)) } catch { return answer('UNKNOWN') }
    answer(stats && stats.isDirectory() ? 'PRESENT' : 'ABSENT')
  },

  // Copy into a stage first, so an unreadable snapshot fails before live state is touched.
  'snapshot-restore': withStateMutationLock(async (root, snapshotDir) => {
    const state = path.join(snapshotDir, STATE_DIR)
    const stats = lstatOrNull(state)
    if (!stats || !stats.isDirectory()) return ('MISSING')
    const stage = path.join(root, RESTORE_STAGE)
    try {
      fs.mkdirSync(root, { recursive: true })
      await removeTreeAsync(stage)
      await fs.promises.cp(state, stage, { recursive: true })
      if (!MEMBERS.some((member) => lstatOrNull(path.join(stage, member)))) {
        await removeTreeAsync(stage)
        return ('FAILED')
      }
    } catch {
      try { await removeTreeAsync(stage) } catch {}
      return ('FAILED')
    }
    try {
      for (const member of MEMBERS) await removeTreeAsync(path.join(root, member))
      for (const member of MEMBERS) {
        if (lstatOrNull(path.join(stage, member))) renameWithRetry(path.join(stage, member), path.join(root, member))
      }
      await removeTreeAsync(stage)
    } catch { return ('FAILED') }
    return 'RESTORED'
  }),

  'snapshot-clear': withStateMutationLock(async (root) => {
    try {
      fs.mkdirSync(root, { recursive: true })
      for (const member of MEMBERS) await removeTreeAsync(path.join(root, member))
    } catch { return ('FAILED') }
    return 'RESTORED'
  }),

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
