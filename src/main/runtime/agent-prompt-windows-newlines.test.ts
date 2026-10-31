import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithControllerKnowsPtyIsLive } from './terminal/input/terminal-input-dispatch'

vi.mock('./terminal/recovery/resolve-terminal-pane', () => ({
  OrcaRuntimeWithResolveTerminalPane: class {}
}))

type Agent = 'codex' | 'claude'
type InputKind = 'driving' | 'launch'

function send(
  prompt: string,
  options: {
    launchAgent: Agent
    foregroundAgent?: Agent
    isWsl?: boolean
    platform: NodeJS.Platform
    inputKind: InputKind
  }
) {
  const payloads: string[] = []
  const runtime = Object.assign(Object.create(OrcaRuntimeWithControllerKnowsPtyIsLive.prototype), {
    ptysById: new Map([
      [
        'pty',
        {
          launchAgent: options.launchAgent,
          foregroundAgent: options.foregroundAgent ?? null,
          isWsl: options.isWsl ?? false,
          wslDistro: options.isWsl ? 'Ubuntu' : null
        }
      ]
    ]),
    getPtyWriteHostPlatform: () => options.platform,
    startRestoredHandlePane: () => null,
    getLivePtyForHandle: () => ({ pty: { connected: true, ptyId: 'pty' } }),
    getPtyLifecycleGeneration: () => 1,
    serializeAgentPromptSubmission: (
      _pty: string,
      _generation: number,
      action: () => Promise<unknown>
    ) => action(),
    assertLiveTerminalHandleTargetsPty: () => {},
    assertAgentPromptGeneration: () => {},
    writeTerminalAgentPrompt: async (
      _handle: string,
      _pty: string,
      _generation: number,
      payload: string
    ) => {
      payloads.push(payload)
      return { submits: 1 }
    }
  })
  return {
    payloads,
    result: runtime.sendTerminalAgentPrompt('handle', prompt, { inputKind: options.inputKind })
  }
}

describe('Windows agent prompt newline encoding', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['driving', 'launch'] as const)(
    'preserves Windows Codex %s as one draft with normalized newlines and sanitized ESC',
    async (inputKind) => {
      const prompt = 'first\r\nsecond\nthird\rfourth ☃\x1b[31m'
      const { payloads, result } = send(prompt, {
        launchAgent: 'codex',
        platform: 'win32',
        inputKind
      })

      const receipt = await result

      expect(payloads).toEqual(['first\x1b\rsecond\x1b\rthird\x1b\rfourth ☃␛[31m'])
      expect(receipt.bytesWritten).toBe(Buffer.byteLength(payloads[0], 'utf8') + 1)
    }
  )

  it('uses the foreground consumer before the launch agent', async () => {
    const { payloads, result } = send('first\nsecond', {
      launchAgent: 'claude',
      foregroundAgent: 'codex',
      platform: 'win32',
      inputKind: 'driving'
    })

    await result

    expect(payloads).toEqual(['first\x1b\rsecond'])
  })

  it('keeps bracketed paste when a Windows Claude process is foregrounded over Codex', async () => {
    const { payloads, result } = send('first\nsecond', {
      launchAgent: 'codex',
      foregroundAgent: 'claude',
      platform: 'win32',
      inputKind: 'driving'
    })

    await result

    expect(payloads).toEqual(['\x1b[200~first\nsecond\x1b[201~'])
  })

  it.each([
    { launchAgent: 'claude', foregroundAgent: 'claude', platform: 'win32' },
    { launchAgent: 'codex', foregroundAgent: 'codex', platform: 'linux' },
    { launchAgent: 'codex', foregroundAgent: 'codex', platform: 'darwin' }
  ] as const)('keeps bracketed paste for $launchAgent on $platform', async (options) => {
    const { payloads, result } = send('first\nsecond', {
      ...options,
      inputKind: 'driving'
    })

    await result

    expect(payloads).toEqual(['\x1b[200~first\nsecond\x1b[201~'])
  })

  it('keeps Linux encoding for a WSL agent carried through Windows ConPTY', async () => {
    const { payloads, result } = send('first\nsecond', {
      launchAgent: 'codex',
      isWsl: true,
      platform: 'win32',
      inputKind: 'driving'
    })

    await result

    expect(payloads).toEqual(['\x1b[200~first\nsecond\x1b[201~'])
  })

  it('keeps launch-paste framing for a WSL Codex process', async () => {
    const { payloads, result } = send('first\nsecond', {
      launchAgent: 'codex',
      isWsl: true,
      platform: 'win32',
      inputKind: 'launch'
    })

    await result

    expect(payloads).toEqual(['\x1b[200~first\rsecond\x1b[201~'])
  })
})
