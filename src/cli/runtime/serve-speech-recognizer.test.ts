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

function resourcesWith(files: string[]): string {
  const resources = mkdtempSync(join(tmpdir(), 'orca-serve-speech-'))
  roots.push(resources)
  for (const file of files) {
    const path = join(resources, 'node_modules', file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '')
  }
  return resources
}

describe("finding the app's speech engines (#31174)", () => {
  it('answers nothing when the app ships no engine for this platform', () => {
    const resources = resourcesWith([
      'transcribe-cpp/package.json',
      '@transcribe-cpp/linux-arm64-cpu-vulkan/contract.json',
      'sherpa-onnx-linux-arm64/sherpa-onnx.node'
    ])
    expect(
      findAppSpeechRecognizerDir(join(resources, 'app.asar.unpacked'), 'linux', 'x64')
    ).toBeUndefined()
  })

  // A loaded addon is locked on Windows; orcad holding the app's copy would block app updates.
  it('never hands orcad the engines on Windows', () => {
    const resources = resourcesWith(['sherpa-onnx-win-x64/sherpa-onnx.node'])
    expect(
      findAppSpeechRecognizerDir(join(resources, 'app.asar.unpacked'), 'win32', 'x64')
    ).toBeUndefined()
  })
})
