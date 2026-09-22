import { RelayRegionPreferenceResolver } from './relay-region-preference'
import type { RelayRegion } from './relay-region-probe'
import type { RelayRegionDecision, RelayRegionWindow } from './relay-region-correction-protocol'

export function createRelayRegionPreferenceReader(input: {
  authConfig: { relayDirectorUrl: string }
  userDataPath: string
}): {
  resolvePreferredRegion: () => Promise<RelayRegion | undefined>
  measureRegionDecision: (window: RelayRegionWindow) => Promise<RelayRegionDecision>
  noteAssignedCell: (cellUrl: string) => void
} {
  const resolver = new RelayRegionPreferenceResolver({
    directorUrl: input.authConfig.relayDirectorUrl,
    userDataPath: input.userDataPath
  })
  return {
    resolvePreferredRegion: () => resolver.resolve(),
    measureRegionDecision: (window) => resolver.measureDecision(window),
    noteAssignedCell: (cellUrl) => void resolver.invalidateIfAssignedCellIsFar(cellUrl)
  }
}
