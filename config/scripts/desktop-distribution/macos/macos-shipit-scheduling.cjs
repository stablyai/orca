const { buildMacNativeAddon } = require('./build-macos-native-addon.cjs')

const SHIPIT_SCHEDULING_ADDON = 'orca_shipit_scheduling.node'

function buildMacShipItScheduling(resourcesDir, arch) {
  return buildMacNativeAddon(resourcesDir, arch, 'macos-shipit-scheduling', SHIPIT_SCHEDULING_ADDON)
}

module.exports = { buildMacShipItScheduling, SHIPIT_SCHEDULING_ADDON }
