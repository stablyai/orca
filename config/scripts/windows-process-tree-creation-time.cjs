'use strict'

/**
 * Prove the compiled addon supports table and synchronous process creation-time reads.
 *
 * Unlike node-pty, this package ships a prebuilt `.node` at the same
 * `build/Release/` path node-gyp writes to, so neither a load nor a path check
 * can tell a stale prebuilt from a source build. pnpm patches the source tree
 * and leaves that prebuilt in place, which is how `ProcessDataFlag.CreationTime`
 * came to exist in `lib/index.js` on a binary that ignores flag 4 -- the gate
 * read true and every row came back without `creationTimeMs`.
 *
 * `supportedProcessDataFlags` is exported by the patched `addon.cc`, so its
 * presence is the binary's own answer. Shared by the Node and Electron probes
 * the way `node-pty-job-ownership.cjs` is.
 */

/** `ProcessDataFlags::CREATIONTIME` in src/process.h. */
const CREATION_TIME_FLAG = 4

function assertWindowsProcessTreeCreationTime({ module, platform = process.platform }) {
  if (platform !== 'win32') {
    return
  }
  const supported = module?.supportedProcessDataFlags
  if (
    typeof supported === 'number' &&
    (supported & CREATION_TIME_FLAG) !== 0 &&
    typeof module?.getProcessCreationTime === 'function'
  ) {
    return
  }
  throw new Error(
    [
      '@vscode/windows-process-tree does not report CreationTime support with a synchronous identity getter',
      `(supportedProcessDataFlags=${String(supported)}).`,
      'This is an unpatched or older binary, so process identities or synchronous',
      'profile-owner recovery are unavailable.',
      'Rebuild it from source so config/patches/@vscode__windows-process-tree@0.8.0.patch applies.'
    ].join(' ')
  )
}

module.exports = { assertWindowsProcessTreeCreationTime, CREATION_TIME_FLAG }
