import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import desktopModePlugin from './android-desktop-mode.js'

const {
  applyActivityDisplayMetrics,
  applyAndroidDesktopModeManifest,
  applyDesktopUnspecifiedOrientation,
  CONFIG_CHANGES
} = desktopModePlugin

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
          activity: [
            {
              $: {
                'android:name': '.MainActivity',
                'android:screenOrientation': 'fullUser'
              }
            }
          ]
        }
      ]
    }
  }
}

describe('android desktop mode plugin', () => {
  it('runs after the rotation-lock plugin', () => {
    const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'))
    const plugins = app.expo.plugins
    expect(plugins.indexOf('./plugins/android-desktop-mode.js')).toBeGreaterThan(
      plugins.indexOf('./plugins/android-respect-rotation-lock.js')
    )
  })

  it('sets desktop activity attributes without clobbering rotation behavior', () => {
    const manifest = applyAndroidDesktopModeManifest(createManifest())
    const activity = manifest.manifest.application[0].activity[0]
    expect(activity.$).toMatchObject({
      'android:configChanges': CONFIG_CHANGES,
      'android:resizeableActivity': 'true',
      'android:supportsPictureInPicture': 'false',
      'android:screenOrientation': 'fullUser'
    })
  })

  it('adds application metadata and properties idempotently', () => {
    const manifest = createManifest()
    applyAndroidDesktopModeManifest(manifest)
    applyAndroidDesktopModeManifest(manifest)
    const application = manifest.manifest.application[0]
    expect(application['meta-data']).toHaveLength(3)
    expect(application.property).toHaveLength(1)
    expect(application['meta-data'].map((entry) => entry.$['android:name'])).toEqual([
      'com.samsung.android.keepalive.density',
      'com.samsung.android.multidisplay.keep_process_alive',
      'android.allow_multiple_resumed_activities'
    ])
  })

  it('adds activity display metrics lifecycle handling idempotently', () => {
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

  it('applies activity metrics after React handles configuration changes', () => {
    const activity = applyActivityDisplayMetrics(MAIN_ACTIVITY)
    const configurationHandler = activity.slice(
      activity.indexOf('override fun onConfigurationChanged')
    )

    expect(configurationHandler.indexOf('super.onConfigurationChanged(newConfig)')).toBeLessThan(
      configurationHandler.indexOf('applyActivityDisplayMetrics()')
    )
  })

  it('adds the desktop orientation hook idempotently after the activity metrics hook', () => {
    const metrics = applyActivityDisplayMetrics(MAIN_ACTIVITY)
    const once = applyDesktopUnspecifiedOrientation(metrics)
    const twice = applyDesktopUnspecifiedOrientation(once)

    expect(twice).toBe(once)
    expect(once.match(/ORCA_DESKTOP_ORIENTATION/g)).toHaveLength(1)
    expect(once.indexOf('applyActivityDisplayMetrics()')).toBeLessThan(
      once.indexOf('super.onCreate(null)')
    )
    expect(once.indexOf('super.onCreate(null)')).toBeLessThan(
      once.indexOf('SCREEN_ORIENTATION_UNSPECIFIED')
    )
  })

  it('fails loudly when the onCreate anchor is missing', () => {
    const noAnchor = MAIN_ACTIVITY.replace(
      'super.onCreate(null)',
      'super.onCreate(savedInstanceState)'
    )
    expect(() => applyDesktopUnspecifiedOrientation(noAnchor)).toThrow(/super\.onCreate\(null\)/)
    expect(() => applyActivityDisplayMetrics(noAnchor)).toThrow(/super\.onCreate\(null\)/)
  })
})
