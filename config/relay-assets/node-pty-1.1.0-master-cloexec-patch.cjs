/**
 * Relay-side pty fd-leak patch for node-pty 1.1.0 (#17915).
 *
 * The app gets this through pnpm `patchedDependencies`; the relay installs stock
 * node-pty from npm onto the host, where no pnpm patch reaches. Stock 1.1.0 leaks
 * a pty fd on both Unix relay platforms, by two unrelated bugs on two code paths.
 *
 * Linux takes forkpty(), which has no atomic O_CLOEXEC, so every later child of
 * the relay -- pty children, git helpers, probes, agent CLIs -- inherits each live
 * master and keeps its /dev/pts device alive for the life of the relay (#8362).
 *
 * macOS takes pty_posix_spawn(), which opens up to three throwaway ptys to push
 * the real master off fds 0-2 and then never closes them: the cleanup loop is
 * `for (; count > 0; count--)`, but in any running process the first posix_openpt()
 * already returns >= 2, so the loop breaks with count == 0 and its body never runs
 * -- and where it does run it closes low_fds[count], never low_fds[0]. Measured on
 * darwin-arm64: one orphaned /dev/ptmx fd per terminal, never returned.
 *
 * macOS does not inherit the master into spawned children today, but not because it
 * is marked: FD_CLOEXEC is not set on it (`lsof +fg` shows R,W,NB, no CX). What
 * closes it is POSIX_SPAWN_CLOEXEC_DEFAULT in pty_posix_spawn's spawn flags, an
 * Apple-only flag that closes every fd in the child. That is one option away from
 * gone -- setting uid/gid drops libuv back to fork()/exec(), which honors nothing
 * but FD_CLOEXEC -- so the master is marked on the Apple path too, exactly as the
 * app's pnpm patch marks it. Windows has no fds and is excluded.
 *
 * The compile it buys differs by platform. Linux relays already run node-gyp at
 * install time (1.1.0 ships no linux prebuild), so this is a second compile on a
 * path that already compiles. macOS runs the shipped darwin prebuild and has no
 * build/ at all, so this is its first compile -- the price of the only fix there
 * is, since the bug is in the source that prebuild was built from.
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
const PATCHED_SOURCE_SHA256 = '3e6bc1a688aae187d231687130cfc0a11781c672f5f616d73183d471ee8ee65c'

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

// Apple never reaches FORKPTY_CALL_SITE: `default:` sits in the `#else` arm of PtyFork's
// `#if defined(__APPLE__)`, so before this pair the asset patched nothing macOS executes.
const POSIX_SPAWN_CALL_SITE = [
  `  if (pty_nonblock(master) == -1) {
    throw Napi::Error::New(napiEnv, "Could not set master fd to nonblocking.");
  }
#else
`,
  `  if (pty_nonblock(master) == -1) {
    throw Napi::Error::New(napiEnv, "Could not set master fd to nonblocking.");
  }
  if (pty_cloexec(master) == -1) {
    throw Napi::Error::New(napiEnv, "Could not set master fd to close-on-exec.");
  }
#else
`
]

// The throwaway ptys pty_posix_spawn opens to keep the real master off fds 0-2. Byte-identical to
// the app's pnpm patch, so both trees compile the same cleanup.
const LOW_FDS_DECLARATION = [
  `  int low_fds[3];
  size_t count = 0;
`,
  `  int low_fds[3] = {-1, -1, -1};
  size_t count = 0;
`
]

const LOW_FDS_CLEANUP = [
  `  for (; count > 0; count--) {
    close(low_fds[count]);
  }
`,
  `  for (size_t i = 0; i <= count && i < 3; i++) {
    if (low_fds[i] != -1) {
      close(low_fds[i]);
    }
  }
`
]

const REPLACEMENTS = [
  FORWARD_DECLARATION,
  DEFINITION,
  POSIX_SPAWN_CALL_SITE,
  FORKPTY_CALL_SITE,
  LOW_FDS_DECLARATION,
  LOW_FDS_CLEANUP
]

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

// Why a child, for both scripts below: a bad build can abort the process on require, which would
// strand the moved-aside working build. Why each ends in a reachability check: a host that cannot
// show its fds says nothing, and an unobservable flag is not evidence the rebuild was wrong.
//
// Linux's leak is inheritance, so the observation is a later plain child's /proc/self/fd.
const VERIFY_INHERITANCE_SCRIPT = `
const pty = require(process.argv[1]);
const term = pty.spawn('/bin/sh', ['-c', 'exit 0'], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env
});
const probe = require('node:child_process').spawnSync('/bin/sh', ['-c', 'ls -l /proc/self/fd'], { encoding: 'utf8' });
try { term.kill() } catch {}
const listing = probe.stdout || '';
if (probe.status !== 0 || !listing.includes('->')) { console.log('UNVERIFIED'); process.exit(0) }
console.log(listing.includes('ptmx') ? 'LEAKED' : 'ISOLATED');
process.exit(0);
`

// Apple's leak is self-held, not inherited, so the observation is this process's own fd table:
// N live ptys must account for exactly N /dev/ptmx rows. A stock build shows 2N -- the master plus
// the throwaway pty_posix_spawn opened and never closed. lsof, not /proc, because macOS has no
// /proc; a host without lsof cannot say, which is 'unverified', not a failed patch.
const VERIFY_SELF_FDS_SCRIPT = `
const pty = require(process.argv[1]);
const terms = [];
for (let i = 0; i < 3; i++) {
  terms.push(pty.spawn('/bin/sh', ['-c', 'sleep 30'], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env
  }));
}
const probe = require('node:child_process').spawnSync('/bin/sh', ['-c', 'lsof -p ' + process.pid], { encoding: 'utf8', maxBuffer: 1 << 24 });
for (const term of terms) { try { term.kill() } catch {} }
const rows = (probe.stdout || '').split('\\n').filter((line) => line.includes('/dev/ptmx'));
if (probe.status !== 0 || rows.length < terms.length) { console.log('UNVERIFIED'); process.exit(0) }
console.log(rows.length > terms.length ? 'LEAKED' : 'ISOLATED');
process.exit(0);
`

const LEAK_MESSAGE = {
  darwin: 'rebuilt node-pty still leaks a throwaway pty fd per spawn',
  linux: 'rebuilt node-pty still leaks the pty master into later children'
}

/** 'isolated' when the platform's leak is gone, 'unverified' when the host cannot show it. */
function verifyNoPtyFdLeak(relayDir, platform) {
  const script = platform === 'darwin' ? VERIFY_SELF_FDS_SCRIPT : VERIFY_INHERITANCE_SCRIPT
  const result = spawnSync(process.execPath, ['-e', script, nodePtyDir(relayDir)], {
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
  if (output.includes('LEAKED')) {
    throw new Error(LEAK_MESSAGE[platform] || LEAK_MESSAGE.linux)
  }
  return output.includes('ISOLATED') ? 'isolated' : 'unverified'
}

/**
 * What gets moved aside before the compile, and where the compile writes.
 *
 * Linux ships no prebuild, so `build/Release` is both the working build and the compile's output,
 * and moving it aside only arms the rollback. macOS runs `prebuilds/darwin-<arch>` and has no
 * `build/` at all, so the compile writes a new `build/Release` -- which node-pty's loader checks
 * ahead of `prebuilds`. Moving `prebuilds` aside does double duty there: it arms the rollback and
 * it is what makes node-pty's install script fall through from "prebuild found" to `node-gyp
 * rebuild`. Deliberately not `npm_config_build_from_source`, which deletes the prebuilds outright
 * and would leave nothing to roll back to.
 */
function buildLayout(relayDir, platform, arch) {
  const ptyDir = nodePtyDir(relayDir)
  const compiledDir = join(ptyDir, 'build', 'Release')
  if (platform === 'darwin') {
    const prebuildsDir = join(ptyDir, 'prebuilds')
    return {
      compiledDir,
      movedDir: prebuildsDir,
      workingBuildPath: join(prebuildsDir, `darwin-${arch}`, 'pty.node'),
      missingStatus: 'skipped:no-prebuild'
    }
  }
  return {
    compiledDir,
    movedDir: compiledDir,
    workingBuildPath: join(compiledDir, 'pty.node'),
    missingStatus: 'skipped:no-compiled-build'
  }
}

function rollback(relayDir, layout, backupDir) {
  rmSync(layout.compiledDir, { recursive: true, force: true })
  try {
    revertNodePtyMasterCloexecSource(relayDir)
  } catch {
    // The build that is about to be restored predates the patch either way.
  }
  if (existsSync(backupDir)) {
    mkdirSync(dirname(layout.movedDir), { recursive: true })
    renameSync(backupDir, layout.movedDir)
  }
}

/**
 * Patch and rebuild the host's node-pty, or leave it exactly as found.
 * Never throws: the caller is on the connect path and a leaky relay beats no relay.
 */
function applyNodePtyMasterCloexecPatch(relayDir = process.cwd(), options = {}) {
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const rebuild = options.rebuild || rebuildNodePty
  const verify = options.verify || verifyNoPtyFdLeak
  if (platform !== 'linux' && platform !== 'darwin') {
    return 'skipped:unsupported-platform'
  }
  const skipMarkerPath = join(relayDir, SKIP_MARKER_FILENAME)
  if (existsSync(skipMarkerPath)) {
    return 'skipped:earlier-attempt-failed'
  }
  const layout = buildLayout(relayDir, platform, arch)
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
  // Nothing to fall back on means the host runs neither a compile nor the prebuild
  // this platform expects; rebuilding could only take away the artifact the probe
  // just proved loadable.
  if (!existsSync(layout.workingBuildPath)) {
    return layout.missingStatus
  }

  try {
    renameSync(layout.movedDir, backupDir)
  } catch (err) {
    return `skipped:${err.message}`
  }
  try {
    patchNodePtyMasterCloexecSource(relayDir)
    rebuild(relayDir)
    const verdict = verify(relayDir, platform)
    // Discarded, not restored: a tree that gets published must hold no unpatched binary the
    // loader could still fall back to. A later repair recompiles from the patched source.
    rmSync(backupDir, { recursive: true, force: true })
    return verdict === 'isolated' ? 'patched' : 'patched-unverified'
  } catch (err) {
    rollback(relayDir, layout, backupDir)
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
