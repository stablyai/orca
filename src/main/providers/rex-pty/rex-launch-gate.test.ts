import { describe, expect, it, vi } from 'vitest'
import { encodeRexLaunch, prepareRexLaunchGate } from './rex-launch-gate'
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Rex private launch gate', () => {
  it('rejects shell injection via environment names, protected capabilities and NULs', () => {
    expect(() => encodeRexLaunch(['/bin/sh'], { 'BAD;NAME': 'x' })).toThrow()
    expect(() => encodeRexLaunch(['/bin/sh'], { OSC7577_TOKEN: 'x' })).toThrow()
    expect(() => encodeRexLaunch(['/bin/sh'], {}, ['REX_BLOCK'])).toThrow()
    expect(() => encodeRexLaunch(['/bin/sh', 'a\0b'])).toThrow()
    expect(() => encodeRexLaunch(['/bin/sh'], { TEST: 'x'.repeat(300000) })).toThrow()
  })

  it.skipIf(process.platform === 'win32')(
    'wipes an abandoned gate and refuses any later release',
    async () => {
      const payload = encodeRexLaunch(['/bin/sh'], { TEST: 'fixture' })
      const gate = await prepareRexLaunchGate(payload)
      try {
        gate.discard()
        gate.discard()
        expect(payload.every((byte) => byte === 0)).toBe(true)
        await expect(gate.release()).rejects.toThrow('gate already settled')
      } finally {
        await rm(gate.directory, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'wipes payload when private directory creation fails',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'rex-gate-failure-'))
      const payload = encodeRexLaunch(['/bin/sh'], { TEST: 'fixture' })
      try {
        vi.stubEnv('TMPDIR', join(directory, 'missing'))
        await expect(prepareRexLaunchGate(payload)).rejects.toThrow()
        expect(payload.every((byte) => byte === 0)).toBe(true)
      } finally {
        vi.unstubAllEnvs()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'passes arguments and environment exactly via a private FIFO',
    async () => {
      const value = 'single\' double" dollar$HOME backslash\\ newline\n日本語😀'
      const payload = encodeRexLaunch(
        [
          '/bin/sh',
          '-c',
          'printf "%s\\0%s\\0%s\\0%s\\0%s" "$1" "$TEST" "${DELETE+x}" "${SERVER_ONLY+x}" "$OSC7577_TOKEN"',
          'fixture',
          value
        ],
        { TEST: value, DELETE: 'x' },
        ['DELETE']
      )
      const gate = await prepareRexLaunchGate(payload)
      try {
        const info = await lstat(gate.directory)
        expect(info.mode & 0o777).toBe(0o700)
        expect(gate.command.join(' ')).not.toContain(value)
        const child = spawn(gate.command[0], gate.command.slice(1), {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            SERVER_ONLY: 'server-only-fixture',
            payload: 'inherited-payload',
            key: 'inherited-key',
            OSC7577_TOKEN: 'capability-fixture',
            DELETE: 'server-value'
          }
        })
        const chunks: Buffer[] = []
        child.stdout.on('data', (data: Buffer) => chunks.push(data))
        const exited = new Promise<number | null>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', resolve)
        })
        await gate.release()
        expect(await exited).toBe(0)
        expect(Buffer.concat(chunks).toString()).toBe(`${value}\0${value}\0\0\0capability-fixture`)
        expect(payload.every((byte) => byte === 0)).toBe(true)
        await expect(lstat(gate.directory)).rejects.toThrow()
      } finally {
        await rm(gate.directory, { recursive: true, force: true })
      }
    }
  )
})
