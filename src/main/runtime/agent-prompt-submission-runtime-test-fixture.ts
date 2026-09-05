import type { TuiAgent } from '../../shared/tui-agent'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

export const AGENT_PROMPT_TEST_WORKTREE_PATH = '/tmp/worktree-a'
export const AGENT_PROMPT_TEST_WORKTREE_ID = 'repo-1::/tmp/worktree-a'

// Why: the paste path first waits for composer readiness; a settled ready header is the cheapest
// evidence and leaves status, permission and title state untouched for the scenario under test.
export const AGENT_PROMPT_TEST_READY_HEADER =
  ' >_ OpenAI Codex (v0.152.0)\n model:       gpt-5.5 high\n directory:   /tmp/worktree-a\n'

export async function createAgentPromptSubmissionRuntime(
  onWrite: (runtime: OrcaRuntimeService, data: string, writeIndex: number) => void,
  launchAgent: TuiAgent = 'aider',
  options: { seedReadyHeader?: boolean } = {}
): Promise<{ runtime: OrcaRuntimeService; handle: string; writes: string[] }> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const writes: string[] = []
  runtime.setPtyController({
    spawn: async () => ({ id: 'pty-prompt' }),
    write: (_ptyId, data) => {
      writes.push(data)
      onWrite(runtime, data, writes.length)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const terminal = await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
    launchAgent
  })
  if (options.seedReadyHeader !== false) {
    runtime.onPtyData('pty-prompt', AGENT_PROMPT_TEST_READY_HEADER, Date.now())
  }
  return { runtime, handle: terminal.handle, writes }
}
