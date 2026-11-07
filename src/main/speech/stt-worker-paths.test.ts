import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { SPEECH_RECOGNIZER_DIR_ENV } from '../../shared/speech-recognizer-package'
import transcribeCppPackages from '../../shared/transcribe-cpp-packages.json'
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

function writeFile(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
}

// orcad: a packaged host with no Electron resources tree.
describe('speech worker paths on orcad (#31174)', () => {
  it('has no on-device recognizer unless orca serve names one', () => {
    installFakeAppEnvironment({ isPackaged: () => true })
    expect(hasLocalSpeechRecognizer()).toBe(false)
  })

  it("uses the installed app's transcribe-cpp that orca serve names", () => {
    installFakeAppEnvironment({ isPackaged: () => true })
    const dir = handedNodeModules()
    const [, native] = Object.entries(transcribeCppPackages).find(
      ([target]) => target === `${process.platform}-${process.arch}`
    ) ?? ['', 'unshipped-target']
    writeFile(join(dir, 'transcribe-cpp', 'package.json'))
    writeFile(join(dir, native, 'contract.json'))
    expect(getSpeechEngineModulesDir()).toBe(native === 'unshipped-target' ? null : dir)
  })

  it('ignores a named directory that holds no recognizer', () => {
    installFakeAppEnvironment({ isPackaged: () => true })
    handedNodeModules()
    expect(getSpeechEngineModulesDir()).toBeNull()
  })
})
