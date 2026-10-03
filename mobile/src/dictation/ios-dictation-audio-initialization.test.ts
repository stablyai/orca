import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const moduleSource = readFileSync(
  new URL('../../packages/expo-two-way-audio/ios/ExpoTwoWayAudioModule.swift', import.meta.url),
  'utf8'
)

function sliceSource(startPattern: string, endPattern: string): string {
  const start = moduleSource.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = moduleSource.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return moduleSource.slice(start, end)
}

describe('iOS dictation audio initialization', () => {
  it('excludes RemoteIO initialization from simulator builds', () => {
    const initialize = sliceSource('AsyncFunction("initialize")', 'Function("isRecording")')
    const simulatorStart = initialize.indexOf('#if targetEnvironment(simulator)')
    const deviceStart = initialize.indexOf('#else', simulatorStart)
    const conditionalEnd = initialize.indexOf('#endif', deviceStart)

    expect(simulatorStart).toBeGreaterThanOrEqual(0)
    expect(deviceStart).toBeGreaterThan(simulatorStart)
    expect(conditionalEnd).toBeGreaterThan(deviceStart)

    const simulatorPath = initialize.slice(simulatorStart, deviceStart)
    const devicePath = initialize.slice(deviceStart, conditionalEnd)
    expect(simulatorPath).toContain('return false')
    expect(simulatorPath).not.toContain('AudioEngine()')
    expect(devicePath).toContain('if self.audioEngine != nil')
    expect(devicePath).toContain('self.audioEngine = try AudioEngine()')
  })
})
