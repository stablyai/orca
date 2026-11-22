import { expect, it } from 'vitest'

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('../../construction/test-context/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../construction/test-context/orca-runtime-test-lifecycle.spec')
const {
  syncSinglePty,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../construction/test-context/orca-runtime-test-fixtures.spec')

it("asks whether a backgrounded pane's agent survived the command mark its daemon saw", async () => {
  const fixture = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
  const asked: string[] = []
  const runtime = new OrcaRuntimeService(fixture.runtimeStore, undefined, {
    checkHookAgentPresence: async (paneKey) => {
      asked.push(paneKey)
      return 'exited'
    }
  })
  await syncSinglePty(runtime)
  runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-finished', exitCode: 0 })
  expect(asked).toEqual(['tab-1:1'])
})
