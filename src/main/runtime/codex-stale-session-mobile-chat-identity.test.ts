// STA-7370: a Codex pane idles under a neutral `<task> | <cwd>` title with a restored `idle` PTY
// status, so once its hook row aged out of the live window session.tabs dropped the provider
// session and the phone's native chat showed an empty "Start a chat" screen.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { agentHookRuntimeDeps } from '../agent-hooks/agent-hook-runtime-deps'
import { postHookEvent } from '../agent-hooks/server.test-fixtures'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-freshness'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentStatusObservedPaneIdentities } from './agent-status-observed-pane-identity'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'wt-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-codex'
const SESSION = {
  session_id: '019a-codex-session',
  transcript_path: '/home/user/.codex/sessions/rollout.jsonl',
  cwd: '/repo/scratch'
}
// Codex 0.158 title sequence for one turn (src/main/runtime/__fixtures__/codex-0-158-0-timed-turn).
const WORKING_TITLE = '⠋ List and summarize files | scratch'
const IDLE_TITLE = 'List and summarize files | scratch'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-codex-stale-session-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  server.stop()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

async function postCodexHook(payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(
    server,
    { paneKey: PANE_KEY, tabId: TAB_ID, worktreeId: WORKTREE_ID, env: 'production', payload },
    '/hook/codex'
  )
  await response.text()
}

type RuntimeInternals = {
  resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  ptysById: Map<string, { lastAgentStatus: unknown }>
}

function internalsOf(runtime: OrcaRuntimeService): RuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members exist on OrcaRuntimeService (protected); the type names only the two this spec stubs or reads.
  return runtime as unknown as RuntimeInternals
}

/** `launched: false` is Codex typed into a plain shell rather than created with an agent. */
async function runCodexTurn({ launched = true } = {}): Promise<OrcaRuntimeService> {
  const runtime = new OrcaRuntimeService(null, undefined, {
    ...agentHookRuntimeDeps(server, new AgentStatusObservedPaneIdentities(), () => ({
      agentStatusHooksEnabled: true
    }))
  })
  vi.spyOn(internalsOf(runtime), 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/scratch',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'codex'
  })
  await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    ...(launched ? { launchAgent: 'codex' as const } : {}),
    title: 'Terminal'
  })
  const paint = (title: string): void => {
    runtime.onPtyData(PTY_ID, `\x1b]0;${title}\x07`, Date.now())
  }
  paint('scratch')
  await postCodexHook({ ...SESSION, hook_event_name: 'SessionStart' })
  await postCodexHook({
    ...SESSION,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'List and summarize files'
  })
  paint(WORKING_TITLE)
  await postCodexHook({
    ...SESSION,
    hook_event_name: 'PreToolUse',
    tool_name: 'exec_command',
    tool_input: { cmd: 'ls' }
  })
  await postCodexHook({ ...SESSION, hook_event_name: 'Stop', last_assistant_message: 'Done.' })
  paint(IDLE_TITLE)
  // The live foreground read restores Codex's `idle` under the neutral title.
  await vi.waitFor(() => {
    expect(internalsOf(runtime).ptysById.get(PTY_ID)?.lastAgentStatus).toBe('idle')
  })
  return runtime
}

async function listedAgentStatus(runtime: OrcaRuntimeService): Promise<unknown> {
  const tab = (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs[0]
  return tab?.type === 'terminal' ? tab.agentStatus : undefined
}

const PUBLISHED_IDENTITY = expect.objectContaining({
  state: 'done',
  agentType: 'codex',
  providerSession: expect.objectContaining({ id: SESSION.session_id })
})

describe('Codex resume identity on mobile session tabs (STA-7370)', () => {
  it('publishes the session while the finished turn is fresh', async () => {
    const runtime = await runCodexTurn()

    expect(await listedAgentStatus(runtime)).toEqual(PUBLISHED_IDENTITY)
  })

  it('keeps publishing the session as done once the hook row leaves the live window', async () => {
    const runtime = await runCodexTurn()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + AGENT_STATUS_STALE_AFTER_MS + 60_000)

    expect(await listedAgentStatus(runtime)).toEqual(PUBLISHED_IDENTITY)
  })

  it('never revives a spinner from a PTY status the neutral title already disowned', async () => {
    const runtime = await runCodexTurn()
    internalsOf(runtime).ptysById.get(PTY_ID)!.lastAgentStatus = 'working'
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + AGENT_STATUS_STALE_AFTER_MS + 60_000)

    expect(await listedAgentStatus(runtime)).toEqual(PUBLISHED_IDENTITY)
  })

  // The phone opens chat by agentType when the tab carries no launchAgent; the live foreground
  // read that restores Codex's idle names the owner, so the stale session needs no agent claim.
  it('names the agent for a stale session in a pane Codex was typed into', async () => {
    const runtime = await runCodexTurn({ launched: false })
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + AGENT_STATUS_STALE_AFTER_MS + 60_000)

    expect(await listedAgentStatus(runtime)).toEqual(PUBLISHED_IDENTITY)
  })
})
