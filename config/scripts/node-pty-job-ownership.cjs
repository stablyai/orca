'use strict'

const { existsSync, readFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { PE_MACHINE, describePeMachine, readPeMachine } = require('./windows-pe-machine.cjs')

const NODE_PTY_JOB_EXPORTS = ['listJobProcessIds', 'terminateJob', 'assignCurrentProcessToJob']

// Inspect usesCygwinRuntime’s UTF-16 marker: job exports predate MSYS breakaway denial and pass on builds that leak Git Bash children.
// See docs/reference/windows-msys-job-breakaway.md; windows-process-table.ts uses the same binary-marker strategy.
const CYGWIN_BREAKAWAY_MARKER_TEXT = 'msys-2.0.dll'
const CYGWIN_BREAKAWAY_MARKER = Buffer.from(CYGWIN_BREAKAWAY_MARKER_TEXT, 'utf16le')

// Propagate read failures: an unreadable addon must never pass the denial check.
function conptyDeniesCygwinBreakaway(addonPath) {
  return readFileSync(addonPath).includes(CYGWIN_BREAKAWAY_MARKER)
}

const NODE_PTY_CONPTY_SOURCE = join('src', 'win', 'conpty.cc')

// Reject stale source before compiling: rebuilding an old install cannot add the denial; pnpm install must apply the current patch.
// Missing source is left to the post-build binary check.
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

// Check target PE architecture immediately: wrong-arch addons fall back to an unpatched prebuild; unknown architectures remain unjudged.
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

// Inject host state to test same-host behavior on any OS. Missing same-host output is fatal because loader falls back to unsafe upstream prebuild; cross-host or absent package only warns.
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

// Resolve native.dir against node-pty’s lib/, the common base across installed, staged and packaged roots.
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

// Fail closed on unreadable addon: loadNativeModule already loaded it, so a missing path means the gate cannot inspect its subject.
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
  assertRebuiltConptyMatchesArch,
  assertRebuiltConptyDeniesMsysBreakaway,
  conptyDeniesCygwinBreakaway,
  nodePtyAddonPath,
  staleConptySourceBuildError
}
