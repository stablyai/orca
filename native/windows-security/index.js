'use strict'

// Why lazy: non-Windows installs never build the addon, so requiring it at module load would
// break any import of this package on macOS/Linux — including test collection.
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
