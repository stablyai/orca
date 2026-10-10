import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  assertLegacyAiVaultResumeAllowed,
  assertLegacyAiVaultResumeCommandAllowed,
  OPENS_EVERY_STRUCTURED_CHAT,
  projectStructuredAiVaultSessions
} from './structured-session-ownership'
import { installOwnership, listResult } from './structured-session-ownership.test-support'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from '../runtime/structured-agent-runtime-registrations'

const OPENCODE_ID = 'ses_2f9aB3cD4eF5gH6iJ7kL8mN9oP'
const GROK_ID = '019fd600-1a2b-7c3d-8e4f-5a6b7c8d9e0f'
const OMP_ID = '019fd611-2b3c-7d4e-9f50-6b7c8d9e0f1a'
const PI_ID = '019fd622-3c4d-7e5f-a061-7c8d9e0f1a2b'
const OTHER_UUID = '019fd633-4d5e-7f60-b172-8d9e0f1a2b3c'
const OMP_FILE = `/Users/me/.omp/agent/sessions/--Users-me-repo--/2026-10-09T10-00-00-000Z_${OMP_ID}.jsonl`
const PI_FILE = `/Users/me/.pi/agent/sessions/--Users-me-repo--/2026-10-09T10-00-00-000Z_${PI_ID}.jsonl`

const acp = (agent: 'opencode' | 'grok' | 'omp', nativeId: string): AgentSessionProviderHandle => ({
  transport: 'acp',
  agent,
  nativeId
})
const PI_HANDLE: AgentSessionProviderHandle = {
  transport: 'jsonl-rpc',
  agent: 'pi',
  nativeId: PI_FILE
}

const allowed = (command: string) =>
  expect(assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)).resolves
const refused = (command: string) =>
  expect(assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)).rejects.toThrow(
    'agent_session_conflict'
  )

function ownedRow(agent: AiVaultAgent, sessionId: string, filePath: string) {
  const result = listResult()
  result.sessions = [{ ...result.sessions[0]!, agent, sessionId, filePath, title: 'First prompt' }]
  return projectStructuredAiVaultSessions(result, OPENS_EVERY_STRUCTURED_CHAT).sessions[0]
}

afterEach(() => setStructuredAgentSessionHost(null))

describe('Session History rows owned by OpenCode, Grok, OMP and Pi chats', () => {
  it.each([
    {
      handle: acp('opencode', OPENCODE_ID),
      rowAgent: 'opencode' as const,
      sessionId: OPENCODE_ID,
      filePath: `/Users/me/.local/share/opencode/opencode.db#${OPENCODE_ID}`,
      label: 'OpenCode Chat'
    },
    {
      handle: acp('opencode', OPENCODE_ID),
      rowAgent: 'opencode2' as const,
      sessionId: OPENCODE_ID,
      filePath: `/Users/me/.local/share/opencode/opencode.db#${OPENCODE_ID}`,
      label: 'OpenCode Chat'
    },
    {
      handle: acp('grok', GROK_ID),
      rowAgent: 'grok' as const,
      sessionId: GROK_ID,
      filePath: `/Users/me/.grok/sessions/%2FUsers%2Fme%2Frepo/${GROK_ID}/summary.json`,
      label: 'Grok Chat'
    },
    {
      handle: acp('omp', OMP_ID),
      rowAgent: 'omp' as const,
      sessionId: OMP_ID,
      filePath: OMP_FILE,
      label: 'OMP Chat'
    },
    {
      handle: PI_HANDLE,
      rowAgent: 'pi' as const,
      sessionId: PI_ID,
      filePath: PI_FILE,
      label: 'Pi Chat'
    }
  ])(
    'owns the $rowAgent row of a $handle.agent chat and refuses preparing its resume',
    ({ handle, rowAgent, sessionId, filePath, label }) => {
      installOwnership({ handle })
      expect(ownedRow(rowAgent, sessionId, filePath)).toMatchObject({
        title: label,
        structuredSession: { sessionId: 'session-alpha', workspaceId: 'workspace-1' }
      })
      expect(
        ownedRow(rowAgent, OTHER_UUID, filePath.replace(sessionId, OTHER_UUID))
      ).not.toHaveProperty('structuredSession')
      expect(() =>
        assertLegacyAiVaultResumeAllowed({
          agent: rowAgent,
          sessionId,
          filePath,
          codexHome: null,
          executionHostId: 'local'
        })
      ).toThrow('agent_session_conflict')
    }
  )

  it('does not own a row of one agent for a chat of another with the same id', () => {
    installOwnership({ handle: acp('omp', OMP_ID) })
    expect(ownedRow('pi', OMP_ID, OMP_FILE)).not.toHaveProperty('structuredSession')
  })
})

describe('terminal resumes of a conversation an OpenCode chat owns', () => {
  it.each([
    `opencode --session ${OPENCODE_ID}`,
    `opencode -s ${OPENCODE_ID}`,
    `opencode --session=${OPENCODE_ID}`,
    `opencode2 --standalone --session '${OPENCODE_ID}'`,
    `cd '/Users/me/repo' && opencode run -s ${OPENCODE_ID} "keep going"`,
    `opencode -c`,
    `opencode --continue`,
    `opencode --session`,
    // After `--` the flag is prompt text, so the session is resumed, not forked.
    `opencode -s ${OPENCODE_ID} -- --fork`
  ])('refuses %s', async (command) => {
    installOwnership({ handle: acp('opencode', OPENCODE_ID) })
    await refused(command)
  })

  it.each([
    `opencode --session ses_otherSession123`,
    // Ids are case-sensitive.
    `opencode --session ${OPENCODE_ID.toLowerCase()}`,
    `opencode --session ${OPENCODE_ID} --fork`,
    `opencode -c --fork`,
    `opencode`,
    `opencode export ${OPENCODE_ID}`,
    // The `-c` belongs to bash, not to OpenCode.
    `cd /Users/me/src/opencode && bash -c 'make'`
  ])('allows %s', async (command) => {
    installOwnership({ handle: acp('opencode', OPENCODE_ID) })
    await allowed(command)
  })
})

describe('terminal resumes of a conversation a Grok chat owns', () => {
  it.each([
    `grok --resume ${GROK_ID}`,
    `grok -r ${GROK_ID.toUpperCase()}`,
    `grok --resume=${GROK_ID}`,
    `grok --load=${GROK_ID}`,
    `grok -p "continue" --resume "${GROK_ID}"`,
    `grok --resume`,
    `grok -r --minimal`,
    `grok -c`,
    `grok --continue`,
    // A non-UUID value is a title, which may name the owned session.
    `grok --resume "auth refactor"`,
    `grok --resume ${GROK_ID} -- --fork-session`
  ])('refuses %s', async (command) => {
    installOwnership({ handle: acp('grok', GROK_ID) })
    await refused(command)
  })

  it.each([
    `grok --resume ${OTHER_UUID}`,
    `grok --resume ${GROK_ID} --fork-session`,
    `grok -c --fork-session`,
    `grok --session-id ${OTHER_UUID}`,
    `grok -- "fix the bug"`
  ])('allows %s', async (command) => {
    installOwnership({ handle: acp('grok', GROK_ID) })
    await allowed(command)
  })
})

describe('terminal resumes of a conversation an OMP chat owns', () => {
  it.each([
    `omp --resume ${OMP_ID}`,
    `omp --resume '${OMP_FILE}'`,
    `omp -r ${OMP_ID.slice(0, 8)}`,
    `omp --session=${OMP_ID.slice(0, 13)}`,
    `omp --session ./2026-10-09T10-00-00-000Z_${OMP_ID}.jsonl`,
    `omp --resume`,
    `omp -c`,
    `omp --continue "what next"`
  ])('refuses %s', async (command) => {
    installOwnership({ handle: acp('omp', OMP_ID) })
    await refused(command)
  })

  it.each([
    `omp --resume ${OTHER_UUID}`,
    `omp --resume ${OTHER_UUID.slice(0, 8)}`,
    `omp --resume /Users/me/.omp/agent/sessions/--Users-me-repo--/2026-10-09T10-00-00-000Z_${OTHER_UUID}.jsonl`,
    `omp --fork ${OMP_ID}`,
    `omp "hello"`
  ])('allows %s', async (command) => {
    installOwnership({ handle: acp('omp', OMP_ID) })
    await allowed(command)
  })
})

describe('terminal resumes of a conversation a Pi chat owns', () => {
  it.each([
    `pi --session ${PI_ID}`,
    `pi --session '${PI_FILE}'`,
    `pi --session=${PI_FILE}`,
    `pi --session ${PI_ID.slice(0, 8)}`,
    `pi -c`,
    `pi --continue`,
    // `--resume` opens a picker; the next token is a prompt, not a target.
    `pi --resume ${OTHER_UUID}`,
    `pi -r`
  ])('refuses %s', async (command) => {
    installOwnership({ handle: PI_HANDLE })
    await refused(command)
  })

  it.each([
    `pi --session ${OTHER_UUID}`,
    `pi --session /Users/me/.pi/agent/sessions/--Users-me-repo--/2026-10-09T10-00-00-000Z_${OTHER_UUID}.jsonl`,
    `pi --fork '${PI_FILE}'`,
    `pi "hello"`,
    `cd /Users/me/pi && bash -c 'make'`
  ])('allows %s', async (command) => {
    installOwnership({ handle: PI_HANDLE })
    await allowed(command)
  })
})

// Their CLIs read flags case-sensitively, unlike Claude's and Codex's folded flags.
describe('flags in another case', () => {
  it.each([
    { handle: PI_HANDLE, command: `rg foo src/main/pi -C 3` },
    { handle: PI_HANDLE, command: `pi --SESSION ${PI_ID}` },
    { handle: acp('opencode', OPENCODE_ID), command: `opencode -C` },
    { handle: acp('grok', GROK_ID), command: `grok -R ${GROK_ID}` },
    { handle: acp('omp', OMP_ID), command: `omp --Continue` }
  ])("are not the agent's resume flags: $command", async ({ handle, command }) => {
    installOwnership({ handle })
    await allowed(command)
  })

  it('still fold for Claude', async () => {
    installOwnership({ provider: 'claude', providerSessionId: PI_ID })
    await refused(`claude -C`)
  })
})

describe('another agent named in a command', () => {
  it.each([
    `echo pi && claude --resume ${PI_ID}`,
    `echo grok && claude --resume ${PI_ID}`,
    `cd /Users/me/omp && codex resume ${PI_ID}`
  ])('reads a Claude or Codex resume as theirs, not a Pi one: %s', async (command) => {
    installOwnership({ handle: PI_HANDLE })
    await allowed(command)
  })

  it('still reads a Pi resume that follows a Claude one', async () => {
    installOwnership({ handle: PI_HANDLE })
    await refused(`claude --resume ${OTHER_UUID}; pi --session ${PI_ID}`)
  })
})

// The guard runs on every terminal.send text, so a long text naming agents often must stay linear.
describe('parsing cost', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads each token once per agent however often agents are named', async () => {
    installOwnership({ handle: PI_HANDLE })
    const parsedArgs = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.flatMap(({ sessionHistory }) =>
      sessionHistory ? [vi.spyOn(sessionHistory, 'parseResumeArgs')] : []
    )
    const line = 'the claude agent said codex and pi and grok are fine; omp wrote opencode output\n'
    const text = line.repeat(2_000)
    const tokenCount = text.split(/\s+/).filter(Boolean).length

    await allowed(text)
    const argsRead = parsedArgs
      .flatMap((spy) => spy.mock.calls)
      .reduce((sum, [args]) => sum + args.length, 0)
    expect(argsRead).toBeLessThanOrEqual(tokenCount * parsedArgs.length)
  })

  it('still refuses an owned resume after many mentions', async () => {
    installOwnership({ handle: PI_HANDLE })
    await refused(`${'echo pi; '.repeat(5_000)}pi --session ${PI_ID}`)
  })
})
