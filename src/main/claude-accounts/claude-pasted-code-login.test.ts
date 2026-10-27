import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostAccountSignInChannel } from '../../shared/host-account-sign-in-types'
import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
import {
  CLAUDE_PASTED_CODE_REJECTED_MESSAGE,
  parseClaudePastedCodeSignInLink,
  runClaudePastedCodeLogin
} from './claude-pasted-code-login'

// Captured from `claude auth login --claudeai` 2.1.306 with piped stdin (challenge and state
// replaced). It prints the pasted-code link twice: inside an OSC 8 hyperlink and as its text.
const PASTE_LINK =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=CHALLENGE&code_challenge_method=S256&state=STATE'
const TRANSCRIPT = `Opening browser to sign in…\nIf the browser didn't open, visit: \u001b]8;;${PASTE_LINK}\u0007${PASTE_LINK}\u001b]8;;\u0007\nPaste code here if prompted > `
const LOCAL_LINK =
  'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback&state=s'

type RunCommand = (
  args: string[],
  config: ClaudeCommandConfig,
  timeoutMs: number,
  options?: ClaudeCommandOptions
) => Promise<string>

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function hostFolder(): ClaudeCommandConfig {
  const windowsPath = mkdtempSync(join(tmpdir(), 'claude-pasted-code-'))
  roots.push(windowsPath)
  return { windowsPath, linuxPath: null, wslDistro: null }
}

function channel(code = new Promise<string>(() => {})) {
  const controller = new AbortController()
  const value: HostAccountSignInChannel = {
    signal: controller.signal,
    onPrompt: vi.fn(),
    nextCode: () => code
  }
  return { value, controller }
}

describe('parseClaudePastedCodeSignInLink', () => {
  it('reads the pasted-code link from the captured transcript', () => {
    expect(parseClaudePastedCodeSignInLink(TRANSCRIPT)).toBe(new URL(PASTE_LINK).toString())
  })

  it('waits for the whole link and ignores a localhost-callback one', () => {
    expect(parseClaudePastedCodeSignInLink(`visit: ${PASTE_LINK.slice(0, 80)}`)).toBeNull()
    expect(parseClaudePastedCodeSignInLink(`visit: ${LOCAL_LINK}\n`)).toBeNull()
    expect(parseClaudePastedCodeSignInLink('see https://example.com/?code=true \n')).toBeNull()
  })
})

describe('runClaudePastedCodeLogin', () => {
  it('publishes the link, writes the pasted code to stdin, and removes its BROWSER stand-in', async () => {
    const folder = hostFolder()
    const written: string[] = []
    const { value } = channel(Promise.resolve('the-code#state'))
    const runCommand = vi.fn<RunCommand>(async (_args, _config, _timeout, options) => {
      options?.onStdin?.((text) => written.push(text))
      options?.onStdout?.(TRANSCRIPT.slice(0, 200))
      options?.onStdout?.(TRANSCRIPT.slice(200))
      await vi.waitFor(() => expect(written).toEqual(['the-code#state\n']))
      return ''
    })
    await runClaudePastedCodeLogin(folder, runCommand, value, vi.fn())
    expect(runCommand.mock.calls[0][0]).toEqual(['auth', 'login', '--claudeai'])
    expect(runCommand.mock.calls[0][3]).toMatchObject({
      keepStdinOpen: true,
      browser: join(folder.windowsPath, '.orca-sign-in-browser')
    })
    expect(value.onPrompt).toHaveBeenCalledExactlyOnceWith({
      url: new URL(PASTE_LINK).toString(),
      userCode: null,
      needsCode: true
    })
    expect(readdirSync(folder.windowsPath)).toEqual([])
  })

  it('names a refused code in words a person can act on', async () => {
    const { value } = channel(Promise.resolve('wrong'))
    const runCommand = vi.fn<RunCommand>(async (_args, _config, _timeout, options) => {
      let sent = false
      options?.onStdin?.(() => {
        sent = true
      })
      options?.onStdout?.(TRANSCRIPT)
      await vi.waitFor(() => expect(sent).toBe(true))
      throw new Error('Claude command failed: Login failed: Request failed with status code 400')
    })
    await expect(
      runClaudePastedCodeLogin(hostFolder(), runCommand, value, vi.fn())
    ).rejects.toThrow(CLAUDE_PASTED_CODE_REJECTED_MESSAGE)
  })

  it('stops the login when the flow is cancelled, and spawns none once already cancelled', async () => {
    const { value, controller } = channel()
    let signal: AbortSignal | undefined
    const runCommand = vi.fn<RunCommand>(async (_args, _config, _timeout, options) => {
      signal = options?.signal
      await new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () =>
          reject(new Error('Claude sign-in was cancelled.'))
        )
      )
      return ''
    })
    const running = runClaudePastedCodeLogin(hostFolder(), runCommand, value, vi.fn())
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledOnce())
    controller.abort()
    await expect(running).rejects.toThrow('Claude sign-in was cancelled.')
    expect(signal?.aborted).toBe(true)

    const second = vi.fn<RunCommand>()
    await expect(runClaudePastedCodeLogin(hostFolder(), second, value, vi.fn())).rejects.toThrow(
      'Claude sign-in was cancelled.'
    )
    expect(second).not.toHaveBeenCalled()
  })
})
