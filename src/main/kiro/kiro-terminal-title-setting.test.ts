import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/run-process'
import { enableKiroTerminalTitle } from './kiro-terminal-title-setting'

function settingsPathIn(): string {
  return join(mkdtempSync(join(tmpdir(), 'kiro-settings-')), 'nested', 'cli.json')
}

function writeSettings(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

function runner(result: Partial<ProcessResult> = {}) {
  return vi.fn(
    async () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function under test reads only `code` and `timedOut` off the result.
      ({ code: 0, stdout: '', stderr: '', timedOut: false, ...result }) as unknown as ProcessResult
  )
}

describe('enableKiroTerminalTitle', () => {
  it('sets the key through the CLI when Kiro has never written a settings file', async () => {
    const run = runner()
    expect(
      await enableKiroTerminalTitle({ settingsPath: settingsPathIn(), program: 'kiro-cli', run })
    ).toBe('enabled')
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'kiro-cli',
        args: ['settings', 'chat.terminalTitle', 'true']
      })
    )
  })

  it('leaves the rest of the file to the CLI rather than rewriting it', async () => {
    const path = settingsPathIn()
    writeSettings(path, JSON.stringify({ 'autocomplete.theme': 'dark' }))
    const run = runner()
    expect(await enableKiroTerminalTitle({ settingsPath: path, program: 'kiro-cli', run })).toBe(
      'enabled'
    )
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not re-enable a value the user turned off', async () => {
    const path = settingsPathIn()
    writeSettings(path, JSON.stringify({ 'chat.terminalTitle': false }))
    const run = runner()
    expect(await enableKiroTerminalTitle({ settingsPath: path, program: 'kiro-cli', run })).toBe(
      'already-set'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves a file it cannot parse alone', async () => {
    const path = settingsPathIn()
    writeSettings(path, '{ not json')
    const run = runner()
    expect(await enableKiroTerminalTitle({ settingsPath: path, program: 'kiro-cli', run })).toBe(
      'failed'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('reports failure when the CLI call does not succeed', async () => {
    const run = runner({ code: 1, stderr: 'no such setting' })
    expect(
      await enableKiroTerminalTitle({ settingsPath: settingsPathIn(), program: 'kiro-cli', run })
    ).toBe('failed')
  })
})
