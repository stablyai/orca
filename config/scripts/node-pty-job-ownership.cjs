'use strict'

const { readFileSync } = require('node:fs')
const { dirname, resolve } = require('node:path')

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
const CYGWIN_BREAKAWAY_MARKER = Buffer.from('msys-2.0.dll', 'utf16le')

/** PE `Machine`, for the Windows slices we package. Names match electron-builder's Arch enum. */
const PE_MACHINE_BY_ARCH = Object.freeze({ ia32: 0x14c, x64: 0x8664, arm64: 0xaa64 })

/**
 * Whether a `.node` is a PE built for `arch`, or null when the file cannot be read as one.
 *
 * Why the packaged prune needs this: it used to approximate "build/Release holds the target's
 * addon" with `electronArch === process.arch`, which is false for an arm64 slice cross-built on
 * x64 even though that rebuild does produce a correct arm64 addon. Reading the header answers the
 * question the proxy was standing in for. Shape mirrors readElfMachine() in
 * verify-linux-glibc-floor.cjs.
 */
function conptyTargetsArch(addonPath, arch) {
  const expected = PE_MACHINE_BY_ARCH[arch]
  if (expected === undefined) {
    return null
  }
  let binary
  try {
    binary = readFileSync(addonPath)
  } catch {
    return null
  }
  // PE header offset lives at 0x3c; `Machine` is the first field after the 4-byte signature.
  if (binary.length < 0x40) {
    return null
  }
  const peHeaderOffset = binary.readUInt32LE(0x3c)
  if (peHeaderOffset + 6 > binary.length) {
    return null
  }
  return binary.readUInt16LE(peHeaderOffset + 4) === expected
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
  throw new Error(
    [
      `node-pty's conpty native at ${addonPath} predates the Cygwin/MSYS job-breakaway denial.`,
      'It exports the job functions, so it looks patched, but its per-PTY job still carries',
      'JOB_OBJECT_LIMIT_BREAKAWAY_OK and every Git Bash child is created outside the job:',
      'terminatePtyJob reports "terminated" and leaves the tree running.',
      'Rebuild node-pty from source so the current config/patches/node-pty@1.1.0.patch applies',
      '(a worktree sharing node_modules with its main checkout shares that stale addon).',
      'See docs/reference/windows-msys-job-breakaway.md.'
    ].join(' ')
  )
}

module.exports = {
  assertNodePtyJobOwnership,
  assertCygwinBreakawayDenied,
  conptyTargetsArch,
  nodePtyAddonPath
}
