import type { OrcaRuntimeService } from '../../../orca-runtime'

type ReplyRuntime = {
  getTerminalPromptRequestBinding: (
    handle: string
  ) => Pick<
    ReturnType<OrcaRuntimeService['getTerminalPromptRequestBinding']>,
    'ptyId' | 'processIncarnation' | 'generation'
  >
  readTerminal: (
    handle: string,
    options: { screen: true; limit: number }
  ) => Promise<{ draft?: string; source?: string }>
  terminalRunFacts: Pick<OrcaRuntimeService['terminalRunFacts'], 'readInputRevision'>
}

export async function reserveEmptyTerminalDraft(runtime: ReplyRuntime, handle: string) {
  const binding = runtime.getTerminalPromptRequestBinding(handle)
  let expectedRevision = runtime.terminalRunFacts.readInputRevision(binding.ptyId)
  const screen = await runtime.readTerminal(handle, { screen: true, limit: 1 })
  if (screen.source !== 'screen' || (screen.draft ?? '') !== '') {
    throw new Error('terminal_reply_draft_changed')
  }
  // Reserve synchronously before each chunk and Enter; only this operation's next write may advance it.
  return (ptyId: string): void => {
    const current = runtime.getTerminalPromptRequestBinding(handle)
    if (
      ptyId !== binding.ptyId ||
      current.ptyId !== binding.ptyId ||
      current.processIncarnation !== binding.processIncarnation ||
      current.generation !== binding.generation ||
      runtime.terminalRunFacts.readInputRevision(ptyId) !== expectedRevision
    ) {
      throw new Error('terminal_reply_draft_changed')
    }
    expectedRevision += 1
  }
}
