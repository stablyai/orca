'use strict'

let addon = null
function getFocusAssistState() {
  addon ??= require('./build/Release/orca_windows_notifications.node')
  return addon.getFocusAssistState()
}

module.exports = { getFocusAssistState }
