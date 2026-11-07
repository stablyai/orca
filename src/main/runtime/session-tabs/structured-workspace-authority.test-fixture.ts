import type { OrcaRuntimeService } from '../orca-runtime'

export const availableRevealWorkspace: OrcaRuntimeService['prepareStructuredAgentSessionRevealWorkspace'] =
  async (location) => ({
    location,
    current: () => true,
    check: () => {},
    admit: () => {},
    release: Object.assign(() => {}, { isCurrent: () => true })
  })
