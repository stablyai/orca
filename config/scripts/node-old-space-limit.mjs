import os from 'node:os'

const maxOldSpaceSizeMb = 4096
const minOldSpaceSizeMb = 2048
const reservedSystemMemoryMb = 1024

export function getBuildOldSpaceSizeMb(totalMemoryBytes = os.totalmem()) {
  const totalMemoryMb = Math.floor(totalMemoryBytes / 1024 / 1024)
  const hostSizedLimitMb = Math.max(minOldSpaceSizeMb, totalMemoryMb - reservedSystemMemoryMb)

  return Math.min(maxOldSpaceSizeMb, hostSizedLimitMb)
}

export function appendBuildOldSpaceOption(existingNodeOptions, totalMemoryBytes = os.totalmem()) {
  const requestedNodeOptions = `--max-old-space-size=${getBuildOldSpaceSizeMb(totalMemoryBytes)}`
  const trimmedNodeOptions = existingNodeOptions?.trim()

  return trimmedNodeOptions ? `${trimmedNodeOptions} ${requestedNodeOptions}` : requestedNodeOptions
}
