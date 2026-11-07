import type { OrcaRuntimeService } from '../orca-runtime'

export const availableRevealWorkspace: OrcaRuntimeService['prepareStructuredAgentSessionRevealWorkspace'] =
  async () => ({
    current: () => true,
    check: () => {},
    release: Object.assign(() => {}, { isCurrent: () => true })
  })
