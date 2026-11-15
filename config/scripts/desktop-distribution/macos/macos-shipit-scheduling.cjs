const { buildMacNativeAddon } = require('./macos-native-addon.cjs')

const SHIPIT_SCHEDULING_ADDON = 'orca_shipit_scheduling.node'

function buildMacShipItScheduling(resourcesDir, arch) {
  return buildMacNativeAddon({
    nativeDir: 'macos-shipit-scheduling',
    addon: SHIPIT_SCHEDULING_ADDON,
    outputDir: resourcesDir,
    arch
  })
}

module.exports = { buildMacShipItScheduling, SHIPIT_SCHEDULING_ADDON }
