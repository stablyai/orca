import { describe, expect, it, vi } from 'vitest'
import { disposeCodexServerRequest } from './codex-server-request-disposition'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_MCP_ELICITATION_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  CodexPromptRegistry
} from './codex-prompt-registry'
import { codexReadOnlyMcpOff, codexReadOnlyThreadConfig } from './codex-structured-read-only'

const ids = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' }

function answer(
  method: string,
  params: Record<string, unknown>,
  readOnly: 'look-around' | 'reply-only' | null = 'look-around'
) {
  const registry = new CodexPromptRegistry()
  const connection = { respond: vi.fn(), respondWithError: vi.fn() }
  const disposition = disposeCodexServerRequest(
    registry,
    connection,
    { id: 7, method, params: { ...ids, ...params } },
    readOnly
  )
  return { disposition, connection }
}

describe('a read-only Codex session', () => {
  it('approves a read on the allow-list without asking anyone', () => {
    const { disposition, connection } = answer(CODEX_COMMAND_APPROVAL_METHOD, {
      command: `/bin/zsh -lc '"\${ORCA_CLI_COMMAND:-orca}" slack read slack:T1:C1'`
    })
    expect(disposition).toEqual({ kind: 'responded', method: CODEX_COMMAND_APPROVAL_METHOD })
    expect(connection.respond).toHaveBeenCalledWith(7, { decision: 'accept' })
  })

  it("refuses a tidy-up even a look's allowed read", () => {
    const { connection } = answer(
      CODEX_COMMAND_APPROVAL_METHOD,
      { command: `/bin/zsh -lc 'orca slack read slack:T1:C1'` },
      'reply-only'
    )
    expect(connection.respond).toHaveBeenCalledWith(7, { decision: 'decline' })
  })

  it.each([
    "/bin/zsh -lc 'orca connector post slack:T1:C1 --text hi'",
    "/bin/zsh -lc 'gh pr merge 12'",
    "/bin/zsh -lc 'gh api -X POST repos/o/r/issues'"
  ])('refuses %s', (command) => {
    const { connection } = answer(CODEX_COMMAND_APPROVAL_METHOD, { command })
    expect(connection.respond).toHaveBeenCalledWith(7, { decision: 'decline' })
  })

  it('declines an argv array, whose words could hide a flag inside one argument', () => {
    const { connection } = answer(CODEX_COMMAND_APPROVAL_METHOD, {
      command: ['git', 'log', 'x --output=/tmp/leak']
    })
    expect(connection.respond).toHaveBeenCalledWith(7, { decision: 'decline' })
  })

  it('refuses file changes, MCP asks and questions instead of making prompts', () => {
    expect(answer(CODEX_FILE_CHANGE_APPROVAL_METHOD, {}).connection.respond).toHaveBeenCalledWith(
      7,
      {
        decision: 'decline'
      }
    )
    const mcp = answer(CODEX_MCP_ELICITATION_METHOD, {
      _meta: { codex_approval_kind: 'mcp_tool_call' }
    })
    expect(mcp.disposition.kind).toBe('responded')
    expect(mcp.connection.respond).toHaveBeenCalledWith(7, {
      action: 'decline',
      content: null,
      _meta: null
    })
    const question = answer(CODEX_USER_INPUT_METHOD, { questions: [{ id: 'q1' }] })
    expect(question.disposition.kind).toBe('responded')
    expect(question.connection.respondWithError).toHaveBeenCalled()
  })

  it('leaves an ordinary session asking its owner', () => {
    const { disposition } = answer(
      CODEX_COMMAND_APPROVAL_METHOD,
      { command: "/bin/zsh -lc 'gh pr merge 12'" },
      null
    )
    expect(disposition.kind).toBe('prompt')
  })

  it('turns off plugins and web search, and every tool for a reply-only run', () => {
    expect(codexReadOnlyThreadConfig()).toEqual({
      'features.plugins': false,
      web_search: 'disabled'
    })
    expect(codexReadOnlyThreadConfig('reply-only')).toMatchObject({
      'features.shell_tool': false,
      'features.hooks': false
    })
  })
})

/** `config/read` as codex 0.163 answers it, for one server set in `layer`. */
function configRead(layer: Record<string, unknown>) {
  const origin = { name: layer, version: 'sha256:x' }
  return {
    request: vi.fn(async () => ({
      config: { mcp_servers: { probe: { command: 'python3', enabled: true } } },
      origins: {
        'mcp_servers.probe.command': origin,
        'mcp_servers.probe.enabled': origin
      }
    }))
  }
}

describe("a read-only Codex run's MCP servers", () => {
  it('turns off a server a project above the run folder defines, asking from the run folder', async () => {
    const connection = configRead({ type: 'project', dotCodexFolder: '/work/project/.codex' })
    expect(await codexReadOnlyMcpOff(connection, '/work/project/bots/scout')).toEqual({
      'mcp_servers.probe.enabled': false
    })
    expect(connection.request).toHaveBeenCalledWith(
      'config/read',
      { cwd: '/work/project/bots/scout' },
      expect.anything()
    )
  })

  it("refuses the run when a managed layer over the thread's config turns a server on", async () => {
    const connection = configRead({ type: 'legacyManagedConfigTomlFromMdm' })
    await expect(codexReadOnlyMcpOff(connection, '/bots/scout')).rejects.toThrow(
      "won't start a read-only run"
    )
  })

  it('refuses the run when the config cannot be read', async () => {
    const connection = {
      request: vi.fn(async () => {
        throw new Error('config/read unsupported')
      })
    }
    await expect(codexReadOnlyMcpOff(connection, '/bots/scout')).rejects.toThrow(
      "won't start a read-only run"
    )
  })
})
