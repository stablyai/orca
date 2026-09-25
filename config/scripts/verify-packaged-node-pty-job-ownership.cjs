const { existsSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const {
  assertNodePtyJobOwnership,
  conptyDeniesCygwinBreakaway,
  nodePtyAddonPath,
  staleConptySourceBuildError
} = require('./node-pty-job-ownership.cjs')
const { normalizeNodePtyWindowsArch } = require('../packaged-runtime-node-modules.cjs')
const { PE_MACHINE, describePeMachine, readPeMachine } = require('./windows-pe-machine.cjs')

/**
 * Every conpty.node the packaged tree can hand `loadNativeModule`, in its order.
 *
 * Why the order matters: the loader swallows each require failure and falls
 * through, so a wrong-arch or otherwise unloadable build hands the pane to the
 * next candidate. First loadable wins, and the published prebuild is always the
 * last one standing.
 */
function packagedConptyCandidates(resourcesDir, targetArch) {
  const nodePtyDir = join(resourcesDir, 'node_modules', 'node-pty')
  const layouts = [
    { segments: ['build', 'Release'], prebuilt: false },
    { segments: ['build', 'Debug'], prebuilt: false },
    { segments: ['prebuilds', `win32-${targetArch}`], prebuilt: true }
  ]
  // Each layout is tried relative to node-pty's root, then to lib/, before the
  // next layout -- the unbundled then bundled pair node-pty's loader walks.
  return layouts.flatMap(({ segments, prebuilt }) =>
    [nodePtyDir, join(nodePtyDir, 'lib')].map((root) => ({
      path: join(root, ...segments, 'conpty.node'),
      prebuilt
    }))
  )
}

function describeCandidates(candidates) {
  return candidates
    .map((candidate) => `${candidate.path} (${describePeMachine(candidate.machine)})`)
    .join(', ')
}

function loadPackagedConpty(resourcesDir) {
  const packagedRequire = createRequire(join(resourcesDir, 'package.json'))
  const utilsPath = packagedRequire.resolve('./node_modules/node-pty/lib/utils')
  const { loadNativeModule } = packagedRequire(utilsPath)
  const native = loadNativeModule('conpty')
  return { native, addonPath: nodePtyAddonPath(utilsPath, native, 'conpty') }
}

function verifyPackagedNodePtyJobOwnership(resourcesDir, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return
  }

  const { native, addonPath } = (options.loadNative ?? loadPackagedConpty)(resourcesDir)
  assertNodePtyJobOwnership({ platform, nativeName: 'conpty', native, addonPath })
  if (!native.dir.replace(/\\/g, '/').includes('build/Release/')) {
    throw new Error(`Packaged node-pty resolved to ${native.dir}; expected patched build/Release`)
  }
  console.log('[verify-packaged-node-pty] OK — packaged ConPTY owns process trees')
}

/**
 * The half of the packaged check that survives a cross-host build.
 *
 * The export check has to load the addon, so it cannot run when the packaging
 * host is not the target platform/arch -- and that skip is how a Windows
 * release built elsewhere could ship a node-pty that leaks every MSYS pane
 * child out of its job. Reading the binary needs neither.
 *
 * It resolves the addon the way the loader does rather than reading one path:
 * only the PE machine field separates a cross-arch package that built correctly
 * from one whose rebuild silently emitted the host's arch, and the first is a
 * correct package whose leftover prebuild is never reached. See the table in
 * docs/reference/windows-msys-job-breakaway.md.
 *
 * Nothing loadable is fatal, not skipped: that package has no ConPTY backend,
 * which a gate must not shrug at.
 */
function verifyPackagedConptyBreakawayMarker(resourcesDir, targetArch, options = {}) {
  // Deliberately no host-platform gate: the caller has already established that
  // the *target* is Windows, and gating on the host is the very skip this
  // closes.
  const architecture = normalizeNodePtyWindowsArch(targetArch)
  const candidates = packagedConptyCandidates(resourcesDir, architecture)
  const exists = options.exists ?? existsSync
  const present = candidates.filter((candidate) => exists(candidate.path))
  if (present.length === 0) {
    throw new Error(
      [
        `Packaged node-pty for win32-${architecture} has no conpty.node on any path its loader`,
        `tries (${candidates.map((c) => c.path).join(', ')}), so the packaged app has no`,
        'ConPTY backend at all.',
        'Nothing here can be checked for the Cygwin/MSYS job-breakaway denial, and a gate that',
        'cannot see its subject refuses rather than assume.'
      ].join(' ')
    )
  }
  // Read once: the same header answers "which one loads" and "what did we find".
  const inspected = present.map((candidate) => ({
    ...candidate,
    machine: readPeMachine(candidate.path)
  }))
  const loaded = inspected.find((candidate) => candidate.machine === PE_MACHINE[architecture])
  if (!loaded) {
    throw new Error(
      [
        `Packaged node-pty for win32-${architecture} has conpty.node at`,
        `${describeCandidates(inspected)},`,
        'and the app can load none of them: a Windows process only loads a PE of its own',
        `machine, which for win32-${architecture} is`,
        `0x${PE_MACHINE[architecture].toString(16)}.`,
        'Rebuild node-pty for the target architecture and repackage.'
      ].join(' ')
    )
  }
  const addonPath = loaded.path
  if (conptyDeniesCygwinBreakaway(addonPath)) {
    console.log(
      `[verify-packaged-node-pty] OK — win32-${architecture} loads ${addonPath}, which denies ` +
        'MSYS job breakaway'
    )
    return
  }
  if (!loaded.prebuilt) {
    throw staleConptySourceBuildError(addonPath)
  }
  // Past here the app falls back to the published prebuild, which never carries
  // the patch. Why it fell back decides the remedy, and the three are different
  // enough that naming the wrong one wastes the reader's build.
  const unusableSourceBuilds = inspected.filter((candidate) => !candidate.prebuilt)
  if (unusableSourceBuilds.some((candidate) => candidate.machine === null)) {
    throw new Error(
      [
        `Packaged node-pty for win32-${architecture} falls back to ${addonPath}, which predates`,
        'the Cygwin/MSYS job-breakaway denial, because the source build beside it is not a PE',
        `image at all: ${describeCandidates(unusableSourceBuilds)}.`,
        'A truncated, empty or quarantined build artifact looks like this. Rebuild node-pty and',
        'repackage. See docs/reference/windows-msys-job-breakaway.md.'
      ].join(' ')
    )
  }
  if (unusableSourceBuilds.length > 0) {
    throw new Error(
      [
        `Packaged node-pty for win32-${architecture} falls back to ${addonPath}, which predates`,
        'the Cygwin/MSYS job-breakaway denial, because the source build beside it is the wrong',
        `architecture: ${describeCandidates(unusableSourceBuilds)}.`,
        'A cross-arch rebuild that did not honour --arch looks exactly like this. Re-run',
        `config/scripts/rebuild-native-deps.mjs --platform=win32 --arch=${architecture},`,
        'confirm it emitted a conpty.node of that machine, and repackage.',
        'See docs/reference/windows-msys-job-breakaway.md.'
      ].join(' ')
    )
  }
  throw new Error(
    [
      `Packaged node-pty for win32-${architecture} loads ${addonPath}, the published prebuilt`,
      'fallback, which predates the Cygwin/MSYS job-breakaway denial: its per-PTY job still',
      'carries JOB_OBJECT_LIMIT_BREAKAWAY_OK, so every Git Bash pane child is created outside',
      'the job and survives terminatePtyJob.',
      'It is here because this package holds no node-pty source build at all for',
      'prunePackagedNodePty to have replaced it with, and only a host that can build node-pty',
      `for win32-${architecture} produces one.`,
      `If this IS a Windows ${architecture} host, the rebuild did not leave one -- check the`,
      'beforeBuild output above. Otherwise package this Windows slice on a host that can.',
      'See docs/reference/windows-msys-job-breakaway.md.'
    ].join(' ')
  )
}

/**
 * The whole Windows verdict for one packaged slice.
 *
 * Both halves live here rather than in the afterPack hook so that "the marker
 * sweep runs even when the export check cannot" is a tested claim instead of
 * the shape of an if/else somebody could re-nest.
 */
function verifyPackagedWindowsNodePty(resourcesDir, targetArch, options = {}) {
  ;(options.verifyMarker ?? verifyPackagedConptyBreakawayMarker)(resourcesDir, targetArch)
  const hostPlatform = options.hostPlatform ?? process.platform
  if (hostPlatform !== 'win32' || !options.canExecuteTargetArch) {
    console.log(
      '[verify-packaged-node-pty] skipped the export check on a cross-platform or cross-arch package'
    )
    return
  }
  ;(options.verifyExports ?? verifyPackagedNodePtyJobOwnership)(resourcesDir)
}

module.exports = {
  packagedConptyCandidates,
  verifyPackagedConptyBreakawayMarker,
  verifyPackagedNodePtyJobOwnership,
  verifyPackagedWindowsNodePty
}
