import { describe, expect, it } from 'vitest'
import {
  shouldRecordProcessGoneCrash,
  shouldRecoverRendererAfterProcessGone
} from './process-gone-classification'

describe('shouldRecordProcessGoneCrash', () => {
  it('suppresses killed process exits during expected lifecycle teardown', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        processType: 'renderer',
        reason: 'killed',
        exitCode: 15,
        expectedTeardown: 'renderer-reload'
      })
    ).toBe(false)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'GPU',
        reason: 'killed',
        exitCode: 15,
        expectedTeardown: 'app-shutdown'
      })
    ).toBe(false)

    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        processType: 'renderer',
        reason: 'killed',
        exitCode: 9,
        expectedTeardown: 'app-shutdown'
      })
    ).toBe(false)
  })

  it('records real crash reasons during expected renderer-only teardown', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        processType: 'renderer',
        reason: 'crashed',
        exitCode: 5,
        expectedTeardown: 'renderer-reload'
      })
    ).toBe(true)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        processType: 'renderer',
        reason: 'oom',
        exitCode: null,
        expectedTeardown: 'renderer-reload'
      })
    ).toBe(true)
  })

  it('suppresses crash-shaped GPU child exits during expected app shutdown', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'GPU',
        reason: 'crashed',
        exitCode: 5,
        expectedTeardown: 'app-shutdown'
      })
    ).toBe(false)
  })

  it('still records crash-shaped non-GPU child exits during expected app shutdown', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'Utility',
        reason: 'crashed',
        exitCode: 5,
        expectedTeardown: 'app-shutdown'
      })
    ).toBe(true)
  })

  it('still records crash-shaped renderer exits during expected app shutdown', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        processType: 'renderer',
        reason: 'crashed',
        exitCode: 5,
        expectedTeardown: 'app-shutdown'
      })
    ).toBe(true)
  })

  it('skips SIGTERM killed events outside expected lifecycle teardown', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        processType: 'renderer',
        reason: 'killed',
        exitCode: 15,
        expectedTeardown: 'none'
      })
    ).toBe(false)
  })

  it('skips Windows control termination killed events outside expected lifecycle teardown', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        reason: 'killed',
        exitCode: -1073741510,
        expectedTeardown: 'none'
      })
    ).toBe(false)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        reason: 'killed',
        exitCode: 1073807364,
        expectedTeardown: 'none'
      })
    ).toBe(false)
  })

  it('skips recoverable Chromium child process exits', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'GPU',
        reason: 'crashed',
        exitCode: -2147483645,
        expectedTeardown: 'none'
      })
    ).toBe(false)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'gpu',
        reason: 'killed',
        exitCode: 1,
        expectedTeardown: 'none'
      })
    ).toBe(false)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'GPU',
        reason: 'abnormal-exit',
        exitCode: 512,
        expectedTeardown: 'none'
      })
    ).toBe(false)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'GPU',
        reason: 'abnormal-exit',
        exitCode: 8704,
        expectedTeardown: 'none'
      })
    ).toBe(false)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'Utility',
        serviceName: 'network.mojom.NetworkService',
        reason: 'killed',
        exitCode: 9,
        expectedTeardown: 'none'
      })
    ).toBe(false)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'Utility',
        serviceName: 'network.mojom.NetworkService',
        reason: 'crashed',
        exitCode: -1,
        expectedTeardown: 'none'
      })
    ).toBe(false)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'Utility',
        serviceName: 'audio.mojom.AudioService',
        reason: 'killed',
        exitCode: 1,
        expectedTeardown: 'none'
      })
    ).toBe(false)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'Utility',
        serviceName: 'audio.mojom.AudioService',
        reason: 'crashed',
        exitCode: -1,
        expectedTeardown: 'none'
      })
    ).toBe(false)
  })

  it('still records unknown child process crashes', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'Utility',
        serviceName: 'com.orca.unexpected',
        reason: 'crashed',
        exitCode: 5,
        expectedTeardown: 'none'
      })
    ).toBe(true)
  })

  it('still records severe Chromium child process failures', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'GPU',
        reason: 'oom',
        exitCode: 1,
        expectedTeardown: 'none'
      })
    ).toBe(true)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'Utility',
        serviceName: 'network.mojom.NetworkService',
        reason: 'launch-failed',
        exitCode: -1,
        expectedTeardown: 'none'
      })
    ).toBe(true)
  })

  it('still records renderer kills from the recent Linux crash-report cluster', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        processType: 'renderer',
        reason: 'killed',
        exitCode: 61696,
        expectedTeardown: 'none'
      })
    ).toBe(true)
  })

  it('records non-SIGTERM killed process exits outside expected lifecycle teardown', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        processType: 'renderer',
        reason: 'killed',
        exitCode: 9,
        expectedTeardown: 'none'
      })
    ).toBe(true)
  })

  it('records non-SIGTERM child-process killed events during renderer-only reloads', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        processType: 'Utility',
        serviceName: 'com.orca.unexpected',
        reason: 'killed',
        exitCode: 9,
        expectedTeardown: 'renderer-reload'
      })
    ).toBe(true)
  })
})

describe('shouldRecoverRendererAfterProcessGone', () => {
  it('does not recover expected renderer reload teardown', () => {
    expect(
      shouldRecoverRendererAfterProcessGone({
        reason: 'killed',
        expectedTeardown: 'renderer-reload'
      })
    ).toBe(false)
  })

  it('recovers real renderer crashes during renderer reload windows', () => {
    expect(
      shouldRecoverRendererAfterProcessGone({
        reason: 'oom',
        expectedTeardown: 'renderer-reload'
      })
    ).toBe(true)
  })

  it('does not recover during app shutdown', () => {
    expect(
      shouldRecoverRendererAfterProcessGone({
        reason: 'crashed',
        expectedTeardown: 'app-shutdown'
      })
    ).toBe(false)
  })
})
