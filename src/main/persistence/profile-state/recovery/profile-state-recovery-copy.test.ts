import {
  closeSync,
  copyFileSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as processes from '@orca/process-host'
import { copyProfileStateRecoveryFile } from './profile-state-recovery-copy'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(large = true) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-recovery-copy-'))
  directories.push(directory)
  const source = join(directory, '- source with spaces')
  const target = join(directory, 'target')
  const descriptor = openSync(source, 'wx', 0o600)
  try {
    ftruncateSync(descriptor, large ? 8 * 1024 * 1024 + 1 : 100)
    writeSync(descriptor, Buffer.from('retained source'))
  } finally {
    closeSync(descriptor)
  }
  return { directory, source, target }
}

function expectNoTemporary(directory: string): void {
  expect(readdirSync(directory).some((name) => name.startsWith('.orca-recovery-clone-'))).toBe(
    false
  )
}

describe('independent profile recovery copies', () => {
  describe.skipIf(process.platform !== 'darwin')('Darwin clone failure boundaries', () => {
    it('preserves a destination created while the clone process runs', () => {
      const { directory, source, target } = fixture()
      vi.spyOn(processes, 'runProcessSync').mockImplementation((spec) => {
        const temporary = spec.args?.[2]
        if (typeof temporary !== 'string') {
          throw new Error('Missing clone destination')
        }
        copyFileSync(source, temporary)
        writeFileSync(target, 'concurrent destination')
        return { code: 0, signal: null, timedOut: false, stdout: '', stderr: '' }
      })
      expect(() => copyProfileStateRecoveryFile(source, target)).toThrow()
      expect(readFileSync(target, 'utf8')).toBe('concurrent destination')
      expectNoTemporary(directory)
    })
  })
})
