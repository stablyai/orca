import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

// Released-server launch contract must run when current desktop launch route or advertised client list changes.
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
