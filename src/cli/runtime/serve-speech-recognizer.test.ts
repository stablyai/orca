import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findAppSpeechRecognizerDir } from './serve-speech-recognizer'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function resourcesWith(packageName: string): string {
  const resources = mkdtempSync(join(tmpdir(), 'orca-serve-speech-'))
  roots.push(resources)
  const dir = join(resources, 'node_modules', packageName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sherpa-onnx.node'), '')
  return resources
}

describe("finding the app's speech recognizer (#31174)", () => {
  it('finds the copy a packaged app ships in its resources', () => {
    const resources = resourcesWith('sherpa-onnx-linux-x64')
    expect(findAppSpeechRecognizerDir(join(resources, 'app.asar.unpacked'), 'linux', 'x64')).toBe(
      join(resources, 'node_modules', 'sherpa-onnx-linux-x64')
    )
  })

  it('answers nothing when the app ships no recognizer for this platform', () => {
    const resources = resourcesWith('sherpa-onnx-linux-arm64')
    expect(
      findAppSpeechRecognizerDir(join(resources, 'app.asar.unpacked'), 'linux', 'x64')
    ).toBeUndefined()
  })

  // A loaded addon is locked on Windows; orcad holding the app's copy would block app updates.
  it('never hands orcad the recognizer on Windows', () => {
    const resources = resourcesWith('sherpa-onnx-win-x64')
    expect(
      findAppSpeechRecognizerDir(join(resources, 'app.asar.unpacked'), 'win32', 'x64')
    ).toBeUndefined()
  })
})
