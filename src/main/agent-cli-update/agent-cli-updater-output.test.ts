import { describe, expect, it } from 'vitest'
import { plainUpdaterOutput } from './agent-cli-updater-output'

describe('plainUpdaterOutput', () => {
  it('keeps the last frame of a redrawn spinner line and drops escape codes', () => {
    const raw =
      '● From 1.19.4 → 1.19.6\n\u001b[?25l│\n◒ Upgrading\u001b[999D\u001b[J◐ Upgrading.\u001b[999D\u001b[J■ Upgrade failed\n\u001b[?25h■ Upgrade failed for npm (exit code 243).\r\n'
    expect(plainUpdaterOutput(raw)).toBe(
      '● From 1.19.4 → 1.19.6\n│\n■ Upgrade failed\n■ Upgrade failed for npm (exit code 243).'
    )
  })

  it('keeps text a short cursor move only nudges, and progress overwritten by carriage return', () => {
    expect(plainUpdaterOutput('npm \u001b[31mERR!\u001b[39m code\u001b[2D EACCES')).toBe(
      'npm ERR! code EACCES'
    )
    expect(plainUpdaterOutput('10%\r50%\r100%\ndone')).toBe('100%\ndone')
  })
})
