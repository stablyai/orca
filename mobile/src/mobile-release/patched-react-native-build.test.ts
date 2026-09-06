import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('patched React Native native builds', () => {
  it('builds both platforms from source so native text-input patches reach the app', () => {
    const config = JSON.parse(readFileSync(new URL('../../app.json', import.meta.url), 'utf8'))
    const buildProperties = config.expo.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties'
    )?.[1]

    expect(buildProperties?.android?.buildReactNativeFromSource).toBe(true)
    expect(buildProperties?.ios?.buildReactNativeFromSource).toBe(true)
  })
})
