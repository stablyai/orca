import { beforeAll, describe, expect, it } from 'vitest'
import {
  runAntiDetectionAutomationSurfaceProbe,
  type AntiDetectionAutomationSurfaceProbeResult
} from './anti-detection-automation-surface-fixture'

// Why one probe for the whole file: each run boots a full Electron stack and loads a real
// <webview> guest three times. The assertions below read different rows of the same reading.
let probe: AntiDetectionAutomationSurfaceProbeResult

beforeAll(async () => {
  probe = await runAntiDetectionAutomationSurfaceProbe()
}, 120_000)

describe('browser guest automation surface under Electron', () => {
  it('reports navigator.webdriver as false without any injected override', () => {
    expect(probe.native.webdriverValue).toBe(false)
    expect(probe.native.webdriverOnPrototype).toBe(true)
    expect(probe.native.webdriverOwnProperty).toBe(false)
  })

  // Why this is a premise pin, not a guard on our own code: it records what attaching
  // webContents.debugger does to navigator.webdriver, which is the claim the injected override
  // was written to answer. Nothing in src can falsify it; only an engine change can.
  it('leaves navigator.webdriver false when the CDP debugger is attached', () => {
    expect(probe.debuggerAttached.webdriverValue).toBe(false)
    expect(probe.debuggerAttached.webdriverOwnProperty).toBe(false)
  })

  it('keeps webdriver off the navigator instance once the anti-detection script has run', () => {
    expect(probe.scriptInjected.webdriverValue).toBe(false)
    expect(probe.scriptInjected.webdriverOwnProperty).toBe(false)
    expect(probe.scriptInjected.sannysoftWebdriverFailed).toBe(false)
  })

  // Why assert the engine and not our script: the plugins and languages fallbacks are guarded on
  // an empty array. These readings are the reason those guards never open, so a platform where
  // they would open fails here rather than silently swapping in a forged PluginArray.
  it('already exposes the plugins, languages and chrome surface the script used to backfill', () => {
    expect(probe.native.pluginsLength).toBeGreaterThan(0)
    expect(probe.native.pluginsIsPluginArray).toBe(true)
    expect(probe.native.languagesLength).toBeGreaterThan(0)
    expect(probe.native.topFrameChrome).toBe('object')
  })

  // Why this one override still earns its place: Electron gives the top document a window.chrome
  // but leaves subframes without one, and the script is what closes that gap.
  it('gains window.chrome in subframes only once the script has run', () => {
    expect(probe.native.subframeChrome).toBe('undefined')
    expect(probe.scriptInjected.subframeChrome).toBe('object')
  })

  it('passes the plugins, chrome and languages checks bot.sannysoft.com runs', () => {
    expect(probe.scriptInjected.sannysoftPluginsTypeFailed).toBe(false)
    expect(probe.scriptInjected.sannysoftChromeFailed).toBe(false)
    expect(probe.scriptInjected.sannysoftLanguagesFailed).toBe(false)
  })
})
