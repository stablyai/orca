import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'
import { readPtyForegroundGroup } from './pty-master-foreground-observation'

const require = createRequire(import.meta.url)
const unix = process.platform === 'win32' ? null : require('node-pty/lib/unixTerminal')
const supported =
  unix && typeof unix.UnixTerminal.prototype.getForegroundProcessGroup === 'function'
describe.skipIf(process.platform === 'win32')('native PTY foreground group', () => {
  it.skipIf(!process.env.CI && !supported)(
    'reads the live master and retires it before a subsequent terminal can reuse it',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-foreground-native-'))
      let term: pty.IPty | undefined
      let ended = false
      try {
        term = pty.spawn('/bin/sh', ['-c', 'printf ready; read answer'], {
          cols: 80,
          rows: 24,
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }
        })
        const exited = new Promise<void>((resolve) =>
          term?.onExit(() => {
            ended = true
            resolve()
          })
        )
        await new Promise<void>((resolve) =>
          term?.onData((data) => {
            if (data.includes('ready')) {
              resolve()
            }
          })
        )
        const first = readPtyForegroundGroup(term)
        expect(typeof first).toBe('number')
        expect(first).toBe(term.pid)
        expect(readPtyForegroundGroup(term)).toBe(first)
        term.write('done\r')
        await exited
        expect(readPtyForegroundGroup(term)).toBeNull()
        const replacement = pty.spawn('/bin/sh', ['-c', 'printf second'], {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin' }
        })
        await new Promise<void>((resolve) => replacement.onExit(() => resolve()))
        expect(readPtyForegroundGroup(term)).toBeNull()
      } finally {
        if (!ended) {
          term?.kill()
        }
        rmSync(home, { recursive: true, force: true })
      }
    },
    10_000
  )
})
