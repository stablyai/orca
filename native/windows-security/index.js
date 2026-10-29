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
  createFileWithDacl: (path, sddl, data) => getAddon().createFileWithDacl(path, sddl, data),
  grantAccess: (path, sid, mask, options) => getAddon().grantAccess(path, sid, mask, options),
  grantAccessAsync: (path, sid, mask, options) =>
    getAddon().grantAccessAsync(path, sid, mask, options)
}
