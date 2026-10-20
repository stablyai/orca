import type { OrcaRuntimeService } from '../orca-runtime'

/** A no-op sidebar facts layer for runtime doubles whose RPC paths note terminal use or clients. */
export function createSidebarFactsDouble(): OrcaRuntimeService['sidebarFacts'] {
  const facts = {
    terminalUse: { noteTerminalUse: () => {} },
    sortStamps: { noteTerminalStarted: () => {} },
    noteRuntimeClient: () => {},
    readAndHoldPhoneSession: () => () => {},
    reconcileSortStampTiers: async () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these RPC paths read only the members above.
  return facts as unknown as OrcaRuntimeService['sidebarFacts']
}

/** A partial runtime for RPC tests, with the no-op sidebar facts layer unless it brings its own. */
export function runtimeDoubleWithSidebarFacts(double: Record<string, unknown>): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test's RPC path reads only the members its double provides.
  return { sidebarFacts: createSidebarFactsDouble(), ...double } as unknown as OrcaRuntimeService
}
