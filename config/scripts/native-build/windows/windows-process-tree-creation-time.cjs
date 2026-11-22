'use strict'

// Tarball prebuilt shares build/Release path and loads under Node/Electron even when JS exposes CreationTime that binary ignores.
// Require patched addon’s supportedProcessDataFlags export as binary proof, shared by Node/Electron probes.

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
