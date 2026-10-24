import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { SPEECH_RECOGNIZER_DIR_ENV } from '../../shared/speech-recognizer-package'
import { getSherpaModulePath, getSttWorkerPath, hasLocalSpeechRecognizer } from './stt-worker-paths'

const roots: string[] = []
afterEach(() => {
  delete process.env[SPEECH_RECOGNIZER_DIR_ENV]
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// orcad: a packaged host with no Electron resources tree.
describe('speech worker paths on orcad (#31174)', () => {
  it('has no on-device recognizer unless orca serve names one', () => {
    installFakeAppEnvironment({ isPackaged: () => true })
    expect(getSherpaModulePath()).toBeNull()
    expect(hasLocalSpeechRecognizer()).toBe(false)
  })

  it("uses the installed app's recognizer that orca serve names", () => {
    installFakeAppEnvironment({ isPackaged: () => true })
    const dir = mkdtempSync(join(tmpdir(), 'orca-recognizer-'))
    roots.push(dir)
    writeFileSync(join(dir, 'sherpa-onnx.node'), '')
    process.env[SPEECH_RECOGNIZER_DIR_ENV] = dir
    expect(getSherpaModulePath()).toBe(dir)
  })

  it('ignores a named directory that holds no recognizer', () => {
    installFakeAppEnvironment({ isPackaged: () => true })
    const dir = mkdtempSync(join(tmpdir(), 'orca-recognizer-'))
    roots.push(dir)
    process.env[SPEECH_RECOGNIZER_DIR_ENV] = dir
    expect(getSherpaModulePath()).toBeNull()
  })

  it('starts the worker shipped beside the server bundle', () => {
    installFakeAppEnvironment({ isPackaged: () => true })
    expect(getSttWorkerPath()).toBe(join(__dirname, 'stt-worker.js'))
  })
})
