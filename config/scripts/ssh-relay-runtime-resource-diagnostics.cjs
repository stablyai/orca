'use strict'

const DEFAULT_OBSERVATION_MS = 2_000
const MAX_RESOURCE_TYPES = 256

function boundedActiveResources(getActiveResourcesInfo) {
  const resources = getActiveResourcesInfo().map((resource) => String(resource).slice(0, 128))
  return {
    types: resources.slice(0, MAX_RESOURCE_TYPES),
    omitted: Math.max(0, resources.length - MAX_RESOURCE_TYPES)
  }
}

async function observeWindowsResourceSettlement({
  platform = process.platform,
  getActiveResourcesInfo = () => process.getActiveResourcesInfo(),
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  observationMs = DEFAULT_OBSERVATION_MS
} = {}) {
  if (platform !== 'win32') {
    return null
  }
  const immediatelyAfterSmoke = boundedActiveResources(getActiveResourcesInfo)
  // Why: ConPTY cleanup is delayed for output draining; observe only resources that survive it.
  await delay(observationMs)
  return {
    observationMs,
    immediatelyAfterSmoke,
    afterObservation: boundedActiveResources(getActiveResourcesInfo)
  }
}

module.exports = { observeWindowsResourceSettlement }
