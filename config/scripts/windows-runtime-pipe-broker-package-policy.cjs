const { existsSync } = require('node:fs')
const { join } = require('node:path')

const BROKER_RESOURCE = Object.freeze({
  from: 'native/windows-runtime-pipe-broker/.build/orca-pipe-broker.exe',
  to: 'bin/orca-pipe-broker.exe'
})
const UNSIGNED_WINDOWS_CHANNELS = new Set(['hourly', 'daily', 'adhoc'])

function windowsRuntimePipeBrokerResourcesForChannel(channel) {
  if (channel === 'release') {
    return [BROKER_RESOURCE]
  }
  if (UNSIGNED_WINDOWS_CHANNELS.has(channel)) {
    return []
  }
  throw new Error(`Unknown Windows package channel: ${channel}`)
}

function assertWindowsRuntimePipeBrokerAbsent(resourcesDir) {
  const brokerPath = join(resourcesDir, 'bin', 'orca-pipe-broker.exe')
  if (existsSync(brokerPath)) {
    throw new Error(
      `Unsigned Windows package must not contain the runtime pipe broker: ${brokerPath}`
    )
  }
  return brokerPath
}

module.exports = {
  BROKER_RESOURCE,
  UNSIGNED_WINDOWS_CHANNELS,
  assertWindowsRuntimePipeBrokerAbsent,
  windowsRuntimePipeBrokerResourcesForChannel
}
