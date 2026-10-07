import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'
import { TERMINAL_SEND_METHODS } from '../rpc/methods/terminal/terminal-send-method'

// Why: node-pty's cached foreground name is p_comm on macOS, which reports the native Claude
// install as its version directory (`2.1.258`). Reading that as "no agent" silently downgraded
// `terminal.send --enter` from the atomic bracketed-paste route to unframed 16 KiB chunks,
// which Claude's composer truncates for large prompts (STA-4577).
describe('isTerminalRunningSettledPromptAgent foreground confirmation', () => {
  it('delivers an OMP CLI prompt intact with one submit and an honest unsupported receipt', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => 'omp'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const handle = runtime.preAllocateHandleForPty('pty-1')
    const prompt = `Reply ACK once.\n${'ñ🙂'.repeat(4_500)}\n`
    const result = await TERMINAL_SEND_METHODS[0].handler(
      {
        terminal: handle,
        text: prompt,
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      },
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'fixture',
          requestId: 'omp-prompt',
          method: 'terminal.send',
          payloadHash: 'fixture'
        }
      }
    )

    expect(writes).toEqual([`\x1b[200~${prompt}\x1b[201~\r`])
    expect(result).toMatchObject({
      send: {
        accepted: true,
        prompt: {
          stages: ['input_accepted'],
          provider: 'unsupported',
          observation: 'unsupported'
        }
      }
    })
  })

  it.each([
    { label: 'raw text', input: { text: 'raw ñ🙂' }, expected: ['raw ñ🙂'] },
    { label: 'bare Enter', input: { enter: true }, expected: ['\r'] }
  ])('preserves OMP CLI $label without prompt framing', async ({ input, expected }) => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => 'omp'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const handle = runtime.preAllocateHandleForPty('pty-1')

    await TERMINAL_SEND_METHODS[0].handler(
      {
        terminal: handle,
        ...input,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      },
      { runtime }
    )

    expect(writes).toEqual(expected)
  })

  // `2.1.258`: macOS p_comm for the native Claude install. `bash.exe`: the Windows daemon
  // tracker answers with the shell fallback until its async scan lands.
  it.each(['2.1.258', 'bash.exe'])(
    'confirms an unrecognized foreground (%s) before refusing the settled route',
    async (cachedForeground) => {
      const getForegroundProcess = vi.fn(async () => cachedForeground)
      const confirmForegroundProcess = vi.fn(async () => 'claude')
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess,
        confirmForegroundProcess
      })
      syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
      const [terminal] = (await runtime.listTerminals()).terminals

      await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(true)
      expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-1')
      // The confirmed identity is reused; the cached read must not be re-consulted and win.
      expect(getForegroundProcess).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps legacy delivery when confirmation also finds no target agent', async () => {
    const confirmForegroundProcess = vi.fn(async () => 'vim')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => '2.1.258',
      confirmForegroundProcess
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(false)
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
  })

  it('does not confirm when the cached foreground already names a target agent', async () => {
    const confirmForegroundProcess = vi.fn(async () => 'claude')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude',
      confirmForegroundProcess
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(true)
    expect(confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('refuses the settled route when the provider cannot confirm', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => '2.1.258'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(false)
  })
})
