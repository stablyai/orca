import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

// Route code the suite executes; dispatcher registration alone is not coverage (#24901 missed send-path changes).
describe('cross-version wire routing for the send path', () => {
  it.each([
    'src/shared/agent-session-wire-refusals.ts',
    'src/shared/structured-agent-session-mutation.ts',
    'src/shared/structured-agent-session-send-mutation.ts',
    'src/main/runtime/rpc/core.ts',
    'src/main/runtime/rpc/errors.ts',
    'src/main/runtime/rpc/orchestration-contract-fence.ts',
    'src/main/runtime/rpc/orchestration-session-caller.ts',
    'src/main/runtime/rpc/orchestration-legacy-compatibility.ts',
    'src/main/runtime/rpc/orchestration-mutation-executor.ts',
    'src/shared/orchestration-rpc-contract.ts',
    'src/main/runtime/orchestration/db/schema/migrate.ts',
    'src/main/runtime/rpc/ws-transport.ts',
    'src/shared/web-origin-security.ts'
  ])('runs the cross-version suites when %s changes', (file) => {
    expect(classifyPrJobs([file])).toMatchObject({ should_run: true, 'cross-version-wire': true })
  })

  it.each([
    'src/shared/structured-agent-session-send-evidence.ts',
    'src/shared/structured-agent-session-composer.ts',
    'src/shared/structured-agent-session-reducer.ts',
    'src/main/runtime/orchestration/send-agent-turn.ts',
    'src/main/runtime/orchestration/orchestration-caller-identity.ts',
    'src/main/runtime/rpc/orchestration-legacy-mail.ts',
    'src/main/runtime/rpc/methods/orchestration.ts',
    'src/main/runtime/rpc/methods/orchestration/runs/dispatch-methods.ts'
  ])('leaves them off for %s, which no cross-version suite executes', (file) => {
    expect(classifyPrJobs([file])).toMatchObject({ should_run: true, 'cross-version-wire': false })
  })
})
