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
        reason: 'killed',
        exitCode: 15,
        expectedTeardown: 'renderer-reload'
      })
    ).toBe(false)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'child',
        reason: 'killed',
        exitCode: 15,
        expectedTeardown: 'app-shutdown'
      })
    ).toBe(false)
  })

  it('records real crash reasons even during expected lifecycle teardown', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        reason: 'crashed',
        exitCode: 5,
        expectedTeardown: 'renderer-reload'
      })
    ).toBe(true)
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        reason: 'oom',
        exitCode: null,
        expectedTeardown: 'renderer-reload'
      })
    ).toBe(true)
  })

  it('skips SIGTERM killed events outside expected lifecycle teardown', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
        reason: 'killed',
        exitCode: 15,
        expectedTeardown: 'none'
      })
    ).toBe(false)
  })

  it('records non-SIGTERM killed process exits outside expected lifecycle teardown', () => {
    expect(
      shouldRecordProcessGoneCrash({
        source: 'renderer',
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
