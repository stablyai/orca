'use strict'

// Why lazy: non-Windows installs never build the addon, so requiring it at module load would
// break any import of this package on macOS/Linux — including test collection.
let addon = null
function getAddon() {
  if (!addon) {
    addon = require('./build/Release/orca_windows_registry.node')
  }
  return addon
}

const HK = {
  CR: 0x80000000,
  CU: 0x80000001,
  LM: 0x80000002,
  U: 0x80000003,
  PD: 0x80000004,
  CC: 0x80000005,
  DD: 0x80000006
}

function getRegistryKey(root, path) {
  const values = getAddon().getKey(root, path)
  if (!values) {
    return null
  }
  // Null-prototype: a value literally named __proto__ would otherwise reassign the prototype
  // instead of becoming an entry, and silently break the keyed-value contract.
  const byName = Object.create(null)
  for (const value of values) {
    byName[value.name] = value
  }
  return byName
}

module.exports = { HK, getRegistryKey }
