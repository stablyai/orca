import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

// cross-version-paired-structured-launch runs a current desktop's launch route against a released
// server's capabilities, so the route and the client list it sends must start that job.
describe('cross-version wire routing for the paired launch route', () => {
  it.each([
    'src/shared/structured-native-chat-launch-route.ts',
    'src/renderer/src/lib/agent-launch-routing.ts',
    'src/renderer/src/runtime/paired-host-client-capabilities.ts',
    'src/shared/electron-remote-runtime-client-capabilities.ts',
    'src/shared/remote-runtime-client-capabilities.ts'
  ])('runs the cross-version suites when %s changes', (file) => {
    expect(classifyPrJobs([file])).toMatchObject({ should_run: true, 'cross-version-wire': true })
  })

  it('leaves them off for the route input builder, which no cross-version suite executes', () => {
    expect(classifyPrJobs(['src/renderer/src/lib/agent-launch-route-input.ts'])).toMatchObject({
      should_run: true,
      'cross-version-wire': false
    })
  })
})
