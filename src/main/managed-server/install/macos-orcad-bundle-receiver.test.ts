import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { expect, it } from 'vitest'
import { macOrcadReceiverCommand } from './macos-orcad-bundle-receiver'

it.skipIf(process.platform === 'win32')(
  'publishes only digest-matched files and recognizes them on retry',
  () => {
    const slot = mkdtempSync(join(tmpdir(), 'orcad-receiver-'))
    const lock = join(slot, '.install-lock')
    try {
      mkdirSync(join(lock, 'stage'), { recursive: true })
      writeFileSync(join(slot, 'second'), 'old')
      const header = Buffer.from(
        JSON.stringify(
          ['first', 'second'].map((filename) => ({
            filename,
            size: 3,
            sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
          }))
        )
      )
      const command = macOrcadReceiverCommand(process.execPath, header)
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', `${command} stage`],
        cwd: lock,
        input: Buffer.concat([header, Buffer.from('abcbad')]),
        timeoutMs: 10_000
      })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('checksum mismatch: second')
      expect(readFileSync(join(slot, 'first'), 'utf8')).toBe('abc')
      expect(readFileSync(join(slot, 'second'), 'utf8')).toBe('old')
      const retry = runProcessSync({
        program: '/bin/sh',
        args: ['-c', command],
        cwd: slot,
        input: header,
        timeoutMs: 10_000
      })
      expect(retry.stdout.trim()).toBe('10')
    } finally {
      rmSync(slot, { recursive: true, force: true })
    }
  }
)
