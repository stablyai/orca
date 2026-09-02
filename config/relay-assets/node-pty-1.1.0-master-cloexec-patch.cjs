/**
 * Relay-side pty-master close-on-exec patch for node-pty 1.1.0 (#17915).
 *
 * The app gets this through pnpm `patchedDependencies`; the relay installs stock
 * node-pty from npm onto the host, where no pnpm patch reaches. Without it every
 * later child of the relay -- pty children, git helpers, probes, agent CLIs --
 * inherits each live master fd and keeps its /dev/pts device alive for the life
 * of the relay (#8362).
 *
 * Linux only, deliberately: it is the only relay platform that takes forkpty()'s
 * no-atomic-O_CLOEXEC path, and the only one that already compiles node-pty at
 * install time, so the rebuild costs a second compile rather than a first one.
 * macOS re-opens the tty through uv_tty_init's cloexec dup and Windows has no fds.
 *
 * Non-fatal by construction: the working build is moved aside before anything is
 * touched and moved back on any failure, and a failed attempt drops a skip marker
 * so the compile is attempted at most once per relay directory.
 */

const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const EXPECTED_NODE_PTY_VERSION = '1.1.0'
const ORIGINAL_SOURCE_SHA256 = '5e1005d6bdcfbe97b486ee415419fe7adae99035047f07340fbad36419e0bae6'
const PATCHED_SOURCE_SHA256 = '97dea52199216c01b62070758f0f38621ae53adc16c221271dd35ae2d8ee3482'

const STATUS_PREFIX = 'ORCA-NPTY-CLOEXEC:'
const SKIP_MARKER_FILENAME = '.node-pty-cloexec-skip'
const BACKUP_DIRNAME = '.orca-cloexec-prepatch-release'
// Under the caller's 240s SSH command timeout, so the rollback below still runs.
const REBUILD_TIMEOUT_MS = 200000
const VERIFY_TIMEOUT_MS = 15000

const FORWARD_DECLARATION = [
  'static int\npty_nonblock(int);\n',
  'static int\npty_nonblock(int);\n\nstatic int\npty_cloexec(int);\n'
]

const DEFINITION = [
  `static int
pty_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags == -1) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
`,
  `static int
pty_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags == -1) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/**
 * Orca: close-on-exec FD
 *
 * forkpty()/posix_openpt() have no atomic O_CLOEXEC, so a master left without
 * FD_CLOEXEC is inherited by every later child of this process -- including
 * later pty children -- which keeps its /dev/pts device and buffers alive long
 * after its own session ends (#8362).
 */

static int
pty_cloexec(int fd) {
  int flags = fcntl(fd, F_GETFD);
  if (flags == -1) return -1;
  if (flags & FD_CLOEXEC) return 0;
  return fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}
`
]

const FORKPTY_CALL_SITE = [
  `    default:
      if (pty_nonblock(master) == -1) {
        throw Napi::Error::New(napiEnv, "Could not set master fd to nonblocking.");
      }
  }
`,
  `    default:
      if (pty_nonblock(master) == -1) {
        throw Napi::Error::New(napiEnv, "Could not set master fd to nonblocking.");
      }
      if (pty_cloexec(master) == -1) {
        throw Napi::Error::New(napiEnv, "Could not set master fd to close-on-exec.");
      }
  }
`
]

const REPLACEMENTS = [FORWARD_DECLARATION, DEFINITION, FORKPTY_CALL_SITE]

function sourceSha256(source) {
  return createHash('sha256').update(source).digest('hex')
}

function nodePtyDir(relayDir) {
  return resolve(relayDir, 'node_modules', 'node-pty')
}

function inspectNodePtyUnixSource(relayDir) {
  const ptyDir = nodePtyDir(relayDir)
  const sourcePath = join(ptyDir, 'src', 'unix', 'pty.cc')
  const version = JSON.parse(readFileSync(join(ptyDir, 'package.json'), 'utf8')).version
  if (version !== EXPECTED_NODE_PTY_VERSION) {
    throw new Error(`Refusing to patch node-pty ${version}; expected ${EXPECTED_NODE_PTY_VERSION}`)
  }
  return { ptyDir, sourcePath, source: readFileSync(sourcePath, 'utf8') }
}

function writeSourceAtomically(sourcePath, contents) {
  const temporaryPath = `${sourcePath}.orca-patch-${process.pid}`
  // Why: a terminated install must leave one of the two known source versions on disk.
  try {
    writeFileSync(temporaryPath, contents)
    renameSync(temporaryPath, sourcePath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function rewriteSource(source, reverse) {
  let rewritten = source
  for (const [original, patched] of REPLACEMENTS) {
    const from = reverse ? patched : original
    const to = reverse ? original : patched
    if (rewritten.split(from).length - 1 !== 1) {
      throw new Error('Refusing to rewrite unexpected node-pty pty.cc source')
    }
    rewritten = rewritten.replace(from, to)
  }
  return rewritten
}

/** True when the patch was applied, false when it was already installed. */
function patchNodePtyMasterCloexecSource(relayDir = process.cwd()) {
  const inspected = inspectNodePtyUnixSource(relayDir)
  const hash = sourceSha256(inspected.source)
  if (hash === PATCHED_SOURCE_SHA256) {
    return false
  }
  if (hash !== ORIGINAL_SOURCE_SHA256) {
    throw new Error('Refusing to patch unexpected node-pty pty.cc source')
  }
  writeSourceAtomically(inspected.sourcePath, rewriteSource(inspected.source, false))
  assertPatchedNodePtyMasterCloexecSource(relayDir)
  return true
}

function assertPatchedNodePtyMasterCloexecSource(relayDir = process.cwd()) {
  const inspected = inspectNodePtyUnixSource(relayDir)
  if (sourceSha256(inspected.source) !== PATCHED_SOURCE_SHA256) {
    throw new Error('node-pty pty master close-on-exec patch is not installed')
  }
}

function revertNodePtyMasterCloexecSource(relayDir = process.cwd()) {
  const inspected = inspectNodePtyUnixSource(relayDir)
  if (sourceSha256(inspected.source) === ORIGINAL_SOURCE_SHA256) {
    return false
  }
  writeSourceAtomically(inspected.sourcePath, rewriteSource(inspected.source, true))
  return true
}

function rebuildNodePty(relayDir) {
  const result = spawnSync('npm', ['rebuild', '--ignore-scripts=false', 'node-pty'], {
    cwd: relayDir,
    encoding: 'utf8',
    timeout: REBUILD_TIMEOUT_MS,
    windowsHide: true
  })
  if (result.error) {
    throw new Error(`npm rebuild node-pty failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const tail = `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-300)
    throw new Error(`npm rebuild node-pty exited ${result.status ?? result.signal}: ${tail}`)
  }
}

// Why a child: a bad build can abort the process on require, which would strand the
// moved-aside working build. Why the reachability check: a host without /proc cannot
// show inheritance, and an unobservable flag is not evidence the rebuild was wrong.
const VERIFY_SCRIPT = `
const pty = require(process.argv[1]);
const term = pty.spawn('/bin/sh', ['-c', 'exit 0'], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env
});
const probe = require('node:child_process').spawnSync('/bin/sh', ['-c', 'ls -l /proc/self/fd'], { encoding: 'utf8' });
try { term.kill() } catch {}
const listing = probe.stdout || '';
if (probe.status !== 0 || !listing.includes('->')) { console.log('UNVERIFIED'); process.exit(0) }
console.log(listing.includes('ptmx') ? 'INHERITED' : 'ISOLATED');
process.exit(0);
`

/** 'isolated' when a later plain child no longer inherits the master, 'unverified' when /proc cannot say. */
function verifyMasterNotInheritedByLaterChild(relayDir) {
  const result = spawnSync(process.execPath, ['-e', VERIFY_SCRIPT, nodePtyDir(relayDir)], {
    cwd: relayDir,
    encoding: 'utf8',
    timeout: VERIFY_TIMEOUT_MS,
    windowsHide: true
  })
  const output = `${result.stdout || ''}`
  if (result.status !== 0 || result.error) {
    const tail = `${output}${result.stderr || ''}`.trim().slice(-300)
    throw new Error(
      `rebuilt node-pty did not load: ${tail || result.error?.message || result.signal}`
    )
  }
  if (output.includes('INHERITED')) {
    throw new Error('rebuilt node-pty still leaks the pty master into later children')
  }
  return output.includes('ISOLATED') ? 'isolated' : 'unverified'
}

function rollback(relayDir, releaseDir, backupDir) {
  rmSync(releaseDir, { recursive: true, force: true })
  try {
    revertNodePtyMasterCloexecSource(relayDir)
  } catch {
    // The build that is about to be restored predates the patch either way.
  }
  if (existsSync(backupDir)) {
    mkdirSync(dirname(releaseDir), { recursive: true })
    renameSync(backupDir, releaseDir)
  }
}

/**
 * Patch and rebuild the host's node-pty, or leave it exactly as found.
 * Never throws: the caller is on the connect path and a leaky relay beats no relay.
 */
function applyNodePtyMasterCloexecPatch(relayDir = process.cwd(), options = {}) {
  const platform = options.platform || process.platform
  const rebuild = options.rebuild || rebuildNodePty
  const verify = options.verify || verifyMasterNotInheritedByLaterChild
  if (platform !== 'linux') {
    return 'skipped:not-linux'
  }
  const skipMarkerPath = join(relayDir, SKIP_MARKER_FILENAME)
  if (existsSync(skipMarkerPath)) {
    return 'skipped:earlier-attempt-failed'
  }
  const releaseDir = join(nodePtyDir(relayDir), 'build', 'Release')
  const backupDir = join(nodePtyDir(relayDir), BACKUP_DIRNAME)
  // A backup stranded by a connection that died mid-rebuild is stale by definition:
  // whatever repaired node-pty since built from the source now on disk.
  rmSync(backupDir, { recursive: true, force: true })

  let inspected
  try {
    inspected = inspectNodePtyUnixSource(relayDir)
  } catch (err) {
    return `skipped:${err.message}`
  }
  const hash = sourceSha256(inspected.source)
  if (hash === PATCHED_SOURCE_SHA256) {
    return 'already-patched'
  }
  if (hash !== ORIGINAL_SOURCE_SHA256) {
    return 'skipped:unexpected-source'
  }
  // No compiled build means the host runs a prebuild or nothing at all; rebuilding
  // could only take away the artifact the probe just proved loadable.
  if (!existsSync(join(releaseDir, 'pty.node'))) {
    return 'skipped:no-compiled-build'
  }

  try {
    renameSync(releaseDir, backupDir)
  } catch (err) {
    return `skipped:${err.message}`
  }
  try {
    patchNodePtyMasterCloexecSource(relayDir)
    rebuild(relayDir)
    const verdict = verify(relayDir)
    rmSync(backupDir, { recursive: true, force: true })
    return verdict === 'isolated' ? 'patched' : 'patched-unverified'
  } catch (err) {
    rollback(relayDir, releaseDir, backupDir)
    // Bounded on purpose: one compile attempt per relay directory, never a retry loop.
    try {
      writeFileSync(skipMarkerPath, `${new Date().toISOString()} ${err.message}\n`)
    } catch {
      // A relay dir we cannot write to will fail the cheap checks above next time anyway.
    }
    return `failed:${err.message}`
  }
}

if (require.main === module) {
  console.log(`${STATUS_PREFIX}${applyNodePtyMasterCloexecPatch()}`)
}

module.exports = {
  EXPECTED_NODE_PTY_VERSION,
  ORIGINAL_SOURCE_SHA256,
  PATCHED_SOURCE_SHA256,
  SKIP_MARKER_FILENAME,
  STATUS_PREFIX,
  applyNodePtyMasterCloexecPatch,
  assertPatchedNodePtyMasterCloexecSource,
  patchNodePtyMasterCloexecSource,
  revertNodePtyMasterCloexecSource
}
