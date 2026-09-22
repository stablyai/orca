'use strict'

const { existsSync, readFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { PE_MACHINE, describePeMachine, readPeMachine } = require('./windows-pe-machine.cjs')

const NODE_PTY_JOB_EXPORTS = ['listJobProcessIds', 'terminateJob', 'assignCurrentProcessToJob']

/**
 * The wide literal `usesCygwinRuntime` probes for in conpty.cc, as it sits in
 * the compiled addon.
 *
 * Why sniff the binary rather than trust the exports: all three job exports
 * predate the Cygwin/MSYS breakaway denial, so symbol presence cannot tell a
 * current build from one whose per-PTY job still carries
 * JOB_OBJECT_LIMIT_BREAKAWAY_OK. Measured on Windows 11: such a build passes
 * every export check, reports isPtyJobOwnershipAvailable() true, and passes
 * windows-pty-job.win32.test.ts 6/6, while every child of a Git Bash pane is
 * created outside the pane's job and survives terminatePtyJob. See
 * docs/reference/windows-msys-job-breakaway.md.
 *
 * Same shape as stagedRelayAddonIsUnpatched() in
 * src/main/windows/windows-process-table.ts, which already tells a patched
 * addon from a published one by a binary import name.
 */
const CYGWIN_BREAKAWAY_MARKER_TEXT = 'msys-2.0.dll'
const CYGWIN_BREAKAWAY_MARKER = Buffer.from(CYGWIN_BREAKAWAY_MARKER_TEXT, 'utf16le')

/** True when the addon carries the denial. Read errors propagate: callers that cannot read it must not pass. */
function conptyDeniesCygwinBreakaway(addonPath) {
  return readFileSync(addonPath).includes(CYGWIN_BREAKAWAY_MARKER)
}

/** Where the patch adds the literal above, relative to node-pty's root. */
const NODE_PTY_CONPTY_SOURCE = join('src', 'win', 'conpty.cc')

/**
 * The verdict on the source a Windows rebuild is about to compile.
 *
 * Why before compiling and not only after: pnpm materializes node_modules/node-pty
 * from config/patches/node-pty@1.1.0.patch at install time, so an install that
 * predates the denial holds source without it, and no rebuild of that source can
 * yield an addon the post-rebuild gate accepts. Measured on a Windows dev
 * checkout: `--force` compiled for minutes, rewrote conpty.node byte-identical
 * and unpatched, and the gate then advised "rebuild from source" -- the step
 * that had just run. The remedy is a reinstall, and that is what this says.
 *
 * An absent source file is not judged here: node-pty ships it, and the addon
 * gate that follows the rebuild still reads the binary either way.
 */
function assertNodePtySourceDeniesMsysBreakaway({ nodePtyDir }) {
  const sourcePath = join(nodePtyDir, NODE_PTY_CONPTY_SOURCE)
  if (!existsSync(sourcePath)) {
    return
  }
  if (readFileSync(sourcePath, 'utf8').includes(`L"${CYGWIN_BREAKAWAY_MARKER_TEXT}"`)) {
    return
  }
  throw new Error(
    [
      `node-pty's source at ${sourcePath} does not carry the Cygwin/MSYS job-breakaway denial,`,
      'so no rebuild of it can produce an addon that does; the compile was not started.',
      'pnpm applies config/patches/node-pty@1.1.0.patch when it installs node-pty, so run',
      '`pnpm install` to re-materialize it with the current patch, then rerun this command.',
      `If that patch does not itself add L"${CYGWIN_BREAKAWAY_MARKER_TEXT}" to ${NODE_PTY_CONPTY_SOURCE},`,
      'this checkout predates the denial and no reinstall can supply it.',
      'See docs/reference/windows-msys-job-breakaway.md.'
    ].join(' ')
  )
}

/**
 * Why here and not only at packaging: a rebuild that did not honour `--arch`
 * leaves a binary the target cannot load, the app falls back to the published
 * prebuild, and the packaged gate then reports it two steps from the command
 * that could fix it. `PE_MACHINE` covers the Windows arches Orca ships; anything
 * else this cannot judge, so it does not pretend to.
 */
function assertRebuiltConptyMatchesArch(addonPath, rebuildArch) {
  const expected = PE_MACHINE[rebuildArch]
  if (expected === undefined) {
    return
  }
  const machine = readPeMachine(addonPath)
  if (machine === expected) {
    return
  }
  const consequence = [
    ', so node-pty would fall back to the published prebuild, which predates the',
    'Cygwin/MSYS job-breakaway denial and leaks every MSYS pane child out of its job.'
  ].join(' ')
  throw new Error(
    machine === null
      ? `${addonPath} is not a PE image${consequence} Check the ` +
          `node-pty build output above; a truncated or quarantined artifact looks like this.`
      : `${addonPath} is ${describePeMachine(machine)}, but this rebuild targets ` +
          `win32-${rebuildArch} (0x${expected.toString(16)}): node-gyp did not honour ` +
          `--arch${consequence}`
  )
}

/**
 * The verdict on the addon a Windows rebuild just claimed to produce.
 *
 * Takes the host as arguments rather than reading `process`, because the branch
 * that matters -- a rebuild for the very host running it -- is otherwise
 * reachable only from Windows, and a gate nobody can run is a gate nobody
 * checks.
 *
 * Absent is fatal on that host: `loadNativeModule` falls through to
 * prebuilds/win32-<arch>, and the published prebuild predates the denial, so
 * the app would load it with nothing said. A cross-host rebuild need not leave
 * a win32 addon on this disk, and node-pty may not be installed at all --
 * neither is evidence of a bad build.
 */
function assertRebuiltConptyDeniesMsysBreakaway({
  nodePtyDir,
  rebuildArch,
  crossHost,
  warn = console.warn
}) {
  const addonPath = join(nodePtyDir, 'build', 'Release', 'conpty.node')
  if (existsSync(addonPath)) {
    assertRebuiltConptyMatchesArch(addonPath, rebuildArch)
    assertCygwinBreakawayDenied(addonPath, { dir: addonPath })
    return
  }
  if (crossHost || !existsSync(nodePtyDir)) {
    warn(`[rebuild] no addon at ${addonPath}; could not check the MSYS job-breakaway denial.`)
    return
  }
  const prebuildPath = join(nodePtyDir, 'prebuilds', `win32-${rebuildArch}`, 'conpty.node')
  throw new Error(
    `the rebuild reported success but ${addonPath} is not there, so node-pty would fall through ` +
      `to ${prebuildPath}. That published prebuild predates the Cygwin/MSYS ` +
      'job-breakaway denial: every Git Bash pane child would be created outside its job and ' +
      'survive terminatePtyJob. Check the node-pty build output above; a same-host source ' +
      'build must leave conpty.node in build/Release.'
  )
}

/**
 * Absolute path of the addon `loadNativeModule` just resolved.
 *
 * `native.dir` is relative to node-pty's own `lib/`, which is the only base
 * every caller shares -- the project install, a staged rebuild and the packaged
 * resources tree all reach the addon through a different root.
 */
function nodePtyAddonPath(nodePtyUtilsPath, native, nativeName) {
  return resolve(dirname(nodePtyUtilsPath), native.dir, `${nativeName}.node`)
}

function assertNodePtyJobOwnership({ nativeName, native, addonPath, platform = process.platform }) {
  if (platform !== 'win32' || nativeName !== 'conpty') {
    return
  }
  const exported = native?.module ?? native
  const missing = NODE_PTY_JOB_EXPORTS.filter((name) => typeof exported?.[name] !== 'function')
  if (missing.length > 0) {
    throw new Error(
      [
        `node-pty's conpty native is missing ${missing.join(', ')}.`,
        `Resolved from: ${native?.dir ?? 'unknown'}`,
        'That build cannot own a PTY tree, so terminatePtyJob degrades to "unavailable"',
        'and pane teardown falls back to guessing by PID ancestry.',
        'Rebuild node-pty from source so config/patches/node-pty@1.1.0.patch applies.'
      ].join(' ')
    )
  }
  assertCygwinBreakawayDenied(addonPath, native)
}

/**
 * Why this refuses instead of skipping when the addon cannot be read: an
 * unreadable binary is exactly the state that used to pass. `loadNativeModule`
 * has already required this file, so "cannot read it" means the caller did not
 * say which file it loaded, and a gate that cannot see its subject is not a
 * gate.
 */
function assertCygwinBreakawayDenied(addonPath, native) {
  let binary
  try {
    binary = readFileSync(addonPath)
  } catch (error) {
    throw new Error(
      [
        `Cannot read node-pty's conpty native at ${addonPath ?? '<no path given>'}`,
        `(resolved from ${native?.dir ?? 'unknown'}): ${error.message}.`,
        'Without the binary this cannot tell a current build from one that leaks',
        'every MSYS pane child out of its job, so it refuses rather than assume.'
      ].join(' ')
    )
  }
  if (binary.includes(CYGWIN_BREAKAWAY_MARKER)) {
    return
  }
  throw staleConptySourceBuildError(addonPath)
}

/** The verdict on a source build that is simply out of date: rebuild it here. */
function staleConptySourceBuildError(addonPath) {
  return new Error(
    [
      `node-pty's conpty native at ${addonPath} predates the Cygwin/MSYS job-breakaway denial.`,
      'It exports the job functions, so it looks patched, but its per-PTY job still carries',
      'JOB_OBJECT_LIMIT_BREAKAWAY_OK and every Git Bash child is created outside the job:',
      'terminatePtyJob reports "terminated" and leaves the tree running.',
      'Rebuild node-pty from source so the current config/patches/node-pty@1.1.0.patch applies',
      '(a worktree sharing node_modules with its main checkout shares that stale addon).',
      `If that patch no longer adds L"${CYGWIN_BREAKAWAY_MARKER_TEXT}" to conpty.cc then this marker is`,
      'stale, not the addon, and no rebuild can satisfy it.',
      'See docs/reference/windows-msys-job-breakaway.md.'
    ].join(' ')
  )
}

module.exports = {
  CYGWIN_BREAKAWAY_MARKER,
  CYGWIN_BREAKAWAY_MARKER_TEXT,
  assertNodePtyJobOwnership,
  assertCygwinBreakawayDenied,
  assertNodePtySourceDeniesMsysBreakaway,
  assertRebuiltConptyDeniesMsysBreakaway,
  conptyDeniesCygwinBreakaway,
  nodePtyAddonPath,
  staleConptySourceBuildError
}
