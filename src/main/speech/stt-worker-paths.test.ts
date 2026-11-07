import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  SPEECH_RECOGNIZER_DIR_ENV,
  speechRecognizerPackageName
} from '../../shared/speech-recognizer-package'
import { getSpeechEngineModulesDir, hasLocalSpeechRecognizer } from './stt-worker-paths'

const roots: string[] = []
afterEach(() => {
  delete process.env[SPEECH_RECOGNIZER_DIR_ENV]
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function handedNodeModules(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-recognizer-'))
  roots.push(dir)
  process.env[SPEECH_RECOGNIZER_DIR_ENV] = dir
  return dir
}

// orcad: a packaged host with no Electron resources tree.
describe('speech worker paths on orcad (#31174)', () => {
  it('has no on-device recognizer unless orca serve names one', () => {
    installFakeAppEnvironment({ isPackaged: () => true })
    expect(getSpeechEngineModulesDir('sherpa')).toBeNull()
    expect(hasLocalSpeechRecognizer({ files: ['model.int8.onnx'] })).toBe(false)
  })

  it("uses the installed app's recognizer that orca serve names", () => {
    installFakeAppEnvironment({ isPackaged: () => true })
    const dir = handedNodeModules()
    const sherpa = join(dir, speechRecognizerPackageName(process.platform, process.arch))
    mkdirSync(sherpa)
    writeFileSync(join(sherpa, 'sherpa-onnx.node'), '')
    expect(getSpeechEngineModulesDir('sherpa')).toBe(dir)
    expect(hasLocalSpeechRecognizer({ files: ['model.int8.onnx'] })).toBe(true)
    expect(hasLocalSpeechRecognizer({ files: ['model-Q8_0.gguf'] })).toBe(false)
  })

  it('ignores a named directory that holds no recognizer', () => {
    installFakeAppEnvironment({ isPackaged: () => true })
    handedNodeModules()
    expect(getSpeechEngineModulesDir('sherpa')).toBeNull()
  })
})
