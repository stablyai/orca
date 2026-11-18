import { describe, expect, it } from 'vitest'
import { electronSidecarRuntimeMethodName } from './electron-sidecar-method-routing'

describe('electronSidecarRuntimeMethodName', () => {
  it('routes console and network logs to the RPCs the sidecar serves', () => {
    expect(electronSidecarRuntimeMethodName('browserConsoleLog')).toBe('browser.console')
    expect(electronSidecarRuntimeMethodName('browserNetworkLog')).toBe('browser.network')
  })
})
