/**
 * Tests for Windows UTF-8 encoding fix.
 *
 * Integration tests spawn real shell processes to verify the
 * code page and encoding are correctly set by our shell arguments.
 *
 * Why child_process instead of node-pty: node-pty's ConPTY backend requires
 * a real console handle (AttachConsole), which vitest workers don't have.
 * child_process.spawn is sufficient to verify the shell arguments produce
 * the correct encoding configuration.
 */
import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const isWindows = process.platform === 'win32'

describe('Windows PTY UTF-8 encoding', () => {
  describe.skipIf(!isWindows)('real shell encoding verification', () => {
    it('cmd.exe /K chcp 65001 sets code page to UTF-8', () => {
      // Spawn cmd.exe with the same args our fix uses, then query the code page.
      const output = execSync('cmd.exe /C "chcp 65001 > nul && chcp"', {
        encoding: 'utf-8',
        timeout: 10_000
      })

      expect(output).toContain('65001')
    })

    it('cmd.exe echoes CJK characters correctly with code page 65001', () => {
      const output = execSync('cmd.exe /C "chcp 65001 > nul && echo 你好世界"', {
        encoding: 'utf-8',
        timeout: 10_000
      })

      expect(output).toContain('你好世界')
    })

    it('powershell.exe outputs UTF-8 after setting Console encoding', () => {
      const output = execSync(
        'powershell.exe -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding.BodyName"',
        {
          encoding: 'utf-8',
          timeout: 15_000
        }
      )

      expect(output.trim()).toBe('utf-8')
    })

    it('powershell.exe outputs CJK characters correctly with UTF-8 encoding', () => {
      const output = execSync(
        'powershell.exe -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output \'你好世界\'"',
        {
          encoding: 'utf-8',
          timeout: 15_000
        }
      )

      expect(output.trim()).toBe('你好世界')
    })

    it('try/catch in profile loading does not prevent encoding from being set', () => {
      // Simulates a broken $PROFILE that throws a terminating error.
      // Our fix wraps it in try/catch so encoding is still set afterward.
      const output = execSync(
        'powershell.exe -NoProfile -Command "try { throw \'profile broken\' } catch {}; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding.BodyName"',
        {
          encoding: 'utf-8',
          timeout: 15_000
        }
      )

      expect(output.trim()).toBe('utf-8')
    })

    it('without try/catch, a terminating error prevents encoding from being set', () => {
      // Proves that WITHOUT the try/catch fix, a broken profile would prevent
      // the encoding commands from executing. This is the bug the second review caught.
      try {
        execSync(
          'powershell.exe -NoProfile -Command "throw \'profile broken\'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding.BodyName"',
          {
            encoding: 'utf-8',
            timeout: 15_000
          }
        )
        // If we get here, the throw didn't halt execution (shouldn't happen)
        expect.unreachable('throw should have caused a non-zero exit code')
      } catch (err: unknown) {
        // The command fails because the throw halts execution before
        // the encoding line runs — proving why try/catch is necessary.
        const error = err as { status: number; stderr: string }
        expect(error.status).not.toBe(0)
      }
    })
  })
})
