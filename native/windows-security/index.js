'use strict'

// Load lazily because non-Windows installs have no addon, including during test collection.
let addon = null
function getAddon() {
  if (!addon) {
    addon = require('./build/Release/orca_windows_security.node')
  }
  return addon
}

module.exports = {
  currentUserSid: () => getAddon().currentUserSid(),
  getDaclAces: (path) => getAddon().getDaclAces(path),
  setDaclSddl: (path, sddl) => getAddon().setDaclSddl(path, sddl),
  setDaclSddlAsync: (path, sddl) => getAddon().setDaclSddlAsync(path, sddl),
  createFileWithDacl: (path, sddl, data, strict) =>
    getAddon().createFileWithDacl(path, sddl, data, strict),
  readFileWithDacl: (path, maxBytes) => getAddon().readFileWithDacl(path, maxBytes),
  readGenericCredential: (target) => getAddon().readGenericCredential(target),
  writeGenericCredential: (target, user, data) =>
    getAddon().writeGenericCredential(target, user, data),
  grantAccess: (path, sid, mask, options) => getAddon().grantAccess(path, sid, mask, options),
  grantAccessAsync: (path, sid, mask, options) =>
    getAddon().grantAccessAsync(path, sid, mask, options),
  clearStdHandleInheritance: () => getAddon().clearStdHandleInheritance(),
  spawnDetachedIsolated: (file, commandLine, cwd, environmentBlock, onExit) =>
    getAddon().spawnDetachedIsolated(file, commandLine, cwd, environmentBlock, onExit),
  isolatedSpawnBreaksAwayFromJob: () => getAddon().isolatedSpawnBreaksAwayFromJob(),
  // Reads the binding this package resolved, so a build probe tests the binary the app loads.
  hasNativeExport: (name) => typeof getAddon()[name] === 'function'
}
