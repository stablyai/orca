import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'

/**
 * Keep the agent SDK on the structured-Claude side of the toggle.
 *
 * A user who never leaves the terminal/TUI Claude path must not pay for the SDK:
 * importing it evaluates a package that rewrites
 * `process.env.NoDefaultCurrentDirectoryInExePath`, changing how Windows resolves
 * executables for every later subprocess. Loading the structured runtime must not
 * trip that rewrite, which is only true while the SDK stays behind a deferred
 * import inside the session path.
 */
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

describe('claude agent SDK import boundary', () => {
  it('leaves the Windows executable-search environment alone when the runtime loads', async () => {
    // A vitest file runs in its own fork, so this is a clean process; the ambient
    // value is cleared first because the developer's own shell may carry one.
    delete process.env.NoDefaultCurrentDirectoryInExePath
    await import('../runtime/structured-agent-session-runtime')

    expect(process.env.NoDefaultCurrentDirectoryInExePath).toBeUndefined()
  })

  it('still lets the SDK set it, so the guard above is not measuring nothing', async () => {
    // A separate process, not this fork: the assertion has to be about a first
    // evaluation of the package, which a cached module registry cannot give.
    const { NoDefaultCurrentDirectoryInExePath: _cleared, ...env } = process.env
    const probe = spawnProcess({
      program: process.execPath,
      args: [
        '-e',
        `import(${JSON.stringify(SDK_PACKAGE)}).then(() => console.log(String(process.env.NoDefaultCurrentDirectoryInExePath)))`
      ],
      cwd: REPO_ROOT,
      env: env as Record<string, string>,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const observed = await new Promise<string>((settle) => {
      let output = ''
      probe.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk
      })
      probe.once('close', () => settle(output.trim()))
    })

    expect(observed).toBe('1')
  })
})
