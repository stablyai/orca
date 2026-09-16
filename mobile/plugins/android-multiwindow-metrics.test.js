import { describe, expect, it } from 'vitest'
import multiWindowPlugin from './android-multiwindow-metrics.js'

const { injectDisplayMetrics, applyMultiWindowMetricsManifest } = multiWindowPlugin

const MAIN_ACTIVITY = `package com.stably.orca.mobile

import android.os.Bundle
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}
`

describe('injectDisplayMetrics', () => {
  it('injects imports, hooks, and class methods idempotently', () => {
    const once = injectDisplayMetrics(MAIN_ACTIVITY)
    expect(once).toContain('import com.facebook.react.uimanager.DisplayMetricsHolder')
    expect(once).toContain('override fun onConfigurationChanged(newConfig: Configuration)')
    expect(once).toContain('ORCA_MULTIWINDOW_METRICS')
    expect(once.indexOf('applyActivityDisplayMetrics()')).toBeLessThan(
      once.indexOf('super.onCreate(null)')
    )
    expect(once.trimEnd().endsWith('}')).toBe(true)
    expect(injectDisplayMetrics(once)).toBe(once)
  })

  it('throws when the onCreate anchor is missing', () => {
    expect(() => injectDisplayMetrics('class MainActivity {}')).toThrow(/super\.onCreate\(null\)/)
  })
})

describe('applyMultiWindowMetricsManifest', () => {
  const makeManifest = (configChanges) => ({
    manifest: {
      application: [
        {
          $: {},
          activity: [
            { $: { 'android:name': '.MainActivity', 'android:configChanges': configChanges } }
          ],
          'meta-data': []
        }
      ]
    }
  })

  it('appends density without clobbering or duplicating', () => {
    const out = applyMultiWindowMetricsManifest(makeManifest('keyboard|screenSize'))
    expect(out.manifest.application[0].activity[0].$['android:configChanges']).toBe(
      'keyboard|screenSize|density'
    )
    const out2 = applyMultiWindowMetricsManifest(makeManifest('keyboard|density'))
    expect(out2.manifest.application[0].activity[0].$['android:configChanges']).toBe(
      'keyboard|density'
    )
  })
})
