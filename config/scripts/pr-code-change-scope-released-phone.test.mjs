import { expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

it('runs the released phone contract for its current discovery dependencies', () => {
  for (const file of [
    'src/main/native-chat/agent-model-catalog/agent-model-catalog-entry.ts',
    'src/main/native-chat/agent-model-catalog/agent-model-catalog-store.ts',
    'src/main/native-chat/agent-model-catalog/agent-model-catalog-service.ts',
    'src/main/native-chat/agent-model-catalog/agent-model-catalog-lister.ts',
    'src/main/native-chat/agent-model-catalog/agent-model-catalog-listing-waiters.ts',
    'src/main/native-chat/agent-model-catalog/agent-model-catalog-probe-runner.ts',
    'src/main/claude/claude-model-catalog-probe.ts'
  ]) {
    expect(classifyPrJobs([file])['cross-version-wire'], file).toBe(true)
  }
  expect(
    classifyPrJobs(['mobile/src/transport/rpc-client-request-tracker.ts'])['cross-version-wire']
  ).toBe(false)
})
