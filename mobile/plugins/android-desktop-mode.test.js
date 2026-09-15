import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import desktopModePlugin from './android-desktop-mode.js'

const { applyActivityDisplayMetrics, applyAndroidDesktopModeManifest } = desktopModePlugin

const MAIN_ACTIVITY = `package com.stably.orca.mobile

import android.os.Bundle
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}
`

function createManifest() {
  return {
    manifest: {
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [{ $: { 'android:name': '.MainActivity' } }]
        }
      ]
    }
  }
}

describe('android desktop mode plugin', () => {
  it('patches react-native-screens to convert each frame with its display density', () => {
    const workspace = readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')
    const patch = readFileSync(
      new URL('../patches/react-native-screens@4.24.0.patch', import.meta.url),
      'utf8'
    )
    expect(workspace).toContain(
      'react-native-screens@4.24.0: patches/react-native-screens@4.24.0.patch'
    )
    expect(patch).toContain('val density = resources.displayMetrics.density')
    expect(patch).toContain('width.toFloat() / frameDensity')
  })

  it('adds resize and density handling idempotently', () => {
    const manifest = createManifest()
    applyAndroidDesktopModeManifest(manifest)
    applyAndroidDesktopModeManifest(manifest)
    const activity = manifest.manifest.application[0].activity[0]
    expect(activity.$['android:configChanges']).toContain('density')
    expect(activity.$['android:resizeableActivity']).toBe('true')
    expect(manifest.manifest.application[0]['meta-data']).toHaveLength(3)
    expect(manifest.manifest.application[0].property).toHaveLength(1)
  })

  it('adds Activity display metric synchronization once', () => {
    const once = applyActivityDisplayMetrics(MAIN_ACTIVITY)
    const twice = applyActivityDisplayMetrics(once)
    expect(twice).toBe(once)
    expect(once.match(/ORCA_DISPLAY_METRICS/g)).toHaveLength(1)
    expect(once).toContain('DisplayMetricsHolder.setWindowDisplayMetrics(windowMetrics)')
    expect(once).toContain('DisplayMetricsHolder.setScreenDisplayMetrics(screenMetrics)')
    expect(once).toContain('window.decorView.requestLayout()')
    expect(once).toContain('emitActivityDimensions()')
    expect(once.indexOf('applyActivityDisplayMetrics()')).toBeLessThan(
      once.indexOf('super.onCreate(null)')
    )
  })

  it('rejects an Activity without the generated onCreate anchor', () => {
    expect(() =>
      applyActivityDisplayMetrics(
        MAIN_ACTIVITY.replace('super.onCreate(null)', 'super.onCreate(savedInstanceState)')
      )
    ).toThrow(/super\.onCreate\(null\)/)
  })
})
