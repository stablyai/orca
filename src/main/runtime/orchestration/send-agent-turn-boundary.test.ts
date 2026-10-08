import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSourceTree, stripComments } from '../../../shared/source-scan/source-tree-scan'

/**
 * Orca sends a message into an agent on another agent's behalf through `sendAgentTurn`, so there
 * is one place where queue-or-now, and later the sender, are decided. These pins list who still
 * reaches the send primitives directly, and why. Paths are relative to `src/main`.
 */
const MAIN_ROOT = resolve(__dirname, '..', '..')
const shipped = scanSourceTree(MAIN_ROOT).map((file) => ({
  ...file,
  code: stripComments(file.source)
}))

/** `.name`, `?.name` or `['name']` off `receiver`: a call, an optional call, a bind, or the method
 *  passed on as a value. An assignment to the member is its definition, not a use. Not caught: an
 *  alias of the receiver (`const h = host`) or a destructured method (`const { send } = host`). */
function memberUse(name: string, receiver = ''): RegExp {
  const from = receiver && String.raw`${receiver}\s*`
  return new RegExp(
    String.raw`${from}(?:\?\.|\.)\s*${name}\b(?!\s*=[^=>])` +
      String.raw`|${from}(?:\?\.)?\[\s*['"\x60]${name}['"\x60]\s*\]`
  )
}

const TERMINAL_PROMPT = memberUse('sendTerminalAgentPrompt')
// The raw terminal write: text, and Enter if asked, with no agent prompt handling.
const TERMINAL_WRITE = memberUse('sendTerminal')
const SEND_SETTLEMENT_WAIT = memberUse('waitForSendSettlement')
// The session host's own send, off anything named as a host: `host`, `requireInstalledHost()`,
// `(await runtime.ensureStructuredAgentSessionHost())`, `host!`, `(host as X)`.
const HOST_RECEIVER = String.raw`[Hh]ost(?:\([^()]*\))?!?(?:\s+as\s+[\w.]+)?\)?!?`
const STRUCTURED_SEND = new RegExp(
  [
    memberUse('send', HOST_RECEIVER).source,
    String.raw`(?<!\bfunction\s+)\bsendStructuredAgentSessionTurn\s*\(`
  ].join('|')
)

function filesMatching(pattern: RegExp): string[] {
  return shipped
    .filter((file) => pattern.test(file.code))
    .map((file) => file.relativePath)
    .sort()
}

describe('agent turn send boundary', () => {
  it('finds a send primitive however it is reached', () => {
    const found = (pattern: RegExp, line: string) => pattern.test(stripComments(line))
    for (const line of [
      'await runtime.sendTerminalAgentPrompt(handle, prompt, options)',
      'await runtime.sendTerminalAgentPrompt?.(handle, prompt, options)',
      'await runtime\n  .sendTerminalAgentPrompt(handle, prompt, options)',
      'const send = runtime.sendTerminalAgentPrompt.bind(runtime)',
      "await runtime['sendTerminalAgentPrompt'](handle, prompt, options)"
    ]) {
      expect(found(TERMINAL_PROMPT, line), line).toBe(true)
    }
    for (const line of [
      'await host.waitForSendSettlement?.(sessionId, id, { budgetMs })',
      "await host?.['waitForSendSettlement'](sessionId, id, { budgetMs })"
    ]) {
      expect(found(SEND_SETTLEMENT_WAIT, line), line).toBe(true)
    }
    for (const line of [
      'await host.send(caller, params)',
      'await args.host?.send(caller, params)',
      'await getStructuredAgentSessionHost()?.send(caller, params)',
      'await getStructuredAgentSessionHost()!.send(caller, params)',
      'await requireInstalledHost().send(caller, params)',
      'await (await runtime.ensureStructuredAgentSessionHost()).send(caller, params)',
      'await host!.send(caller, params)',
      'await (host as X).send(caller, params)',
      'await structuredHost.send?.(caller, params)',
      "await host['send'](caller, params)",
      'return sendStructuredAgentSessionTurn(context, caller, params)'
    ]) {
      expect(found(STRUCTURED_SEND, line), line).toBe(true)
    }
    for (const line of [
      'await runtime.sendTerminal(handle, { text, enter: true }, options)',
      "await api?.['sendTerminal'](handle, { text }, options)"
    ]) {
      expect(found(TERMINAL_WRITE, line), line).toBe(true)
    }
    for (const [pattern, line] of [
      [TERMINAL_PROMPT, 'async sendTerminalAgentPrompt(handle, prompt, options) {'],
      [TERMINAL_PROMPT, '// runtime.sendTerminalAgentPrompt(handle, prompt, options)'],
      [SEND_SETTLEMENT_WAIT, 'this.waitForSendSettlement = this.sendSettlement.wait'],
      [STRUCTURED_SEND, 'await host.sendTerminal(handle, action, options)'],
      [TERMINAL_WRITE, 'await runtime.sendTerminalAgentPrompt(handle, prompt, options)'],
      [
        STRUCTURED_SEND,
        'export function sendStructuredAgentSessionTurn(context, caller, params) {'
      ],
      [STRUCTURED_SEND, 'await sendAgentTurn({ kind, host, sessionId, callerKey, turn })']
    ] as const) {
      expect(found(pattern, line), line).toBe(false)
    }
  })

  it('lists the agent senders already moved onto sendAgentTurn', () => {
    expect(filesMatching(/\bsendAgentTurn\s*\(/)).toEqual(
      [
        'runtime/orchestration/send-agent-turn.ts',
        // The structured mail-pointer lane.
        'runtime/orchestration/structured-mailbox-pointer-host.ts',
        // Dispatch preambles: structured worker, PTY worker, `dispatch --inject`, the
        // coordinator loop, and a federated worker host.
        'runtime/rpc/methods/orchestration-structured-worker-session.ts',
        'runtime/rpc/methods/orchestration/worker/deliver-worker-dispatch-preamble.ts',
        'runtime/rpc/methods/orchestration/runs/dispatch-methods.ts',
        'runtime/orchestration/coordinator-task-dispatch.ts',
        'runtime/rpc/methods/orchestration/federation/federation.ts',
        // A chat assignee's task, from `dispatch --inject` and `worker-start --terminal`.
        'runtime/rpc/methods/orchestration/chat-task-delivery.ts'
      ].sort()
    )
  })

  it('types an agent prompt into a terminal only from the listed paths', () => {
    expect(
      filesMatching(TERMINAL_PROMPT),
      'A new direct sendTerminalAgentPrompt use. Send an agent message through sendAgentTurn.'
    ).toEqual(
      [
        // `agent.launch`: the prompt an agent is started with, by a user or another agent. With
        // `reuseTerminal` it is typed into an agent already running. Temporary: it needs its own
        // terminal purpose, and the sender in step B.
        'runtime/rpc/methods/agent-launch-terminal-prompt.ts',
        // `terminal.send --enter` (agentPrompt): a user's or an agent's prompt to a named terminal,
        // so it is an agent-to-agent send too. Not moved yet: it carries its own write guard,
        // submit wait and receipts, and no task lead line.
        'runtime/rpc/methods/terminal/terminal-send-method.ts',
        'runtime/orchestration/send-agent-turn.ts'
      ].sort()
    )
  })

  it('sends into a structured session directly only from the listed paths', () => {
    expect(
      filesMatching(STRUCTURED_SEND),
      'A new direct structured send. Send an agent message through sendAgentTurn.'
    ).toEqual(
      [
        'runtime/orchestration/send-agent-turn.ts',
        // The composer's `agentSession.send` RPC: the user's own message.
        'runtime/rpc/methods/structured-agent-session-send-compatibility.ts',
        // `agent.launch` into a structured chat: the first turn of the chat that launch just
        // created, so nothing can be queued ahead of it. The sender comes in step B.
        'runtime/rpc/methods/agent-launch-structured-prompt.ts',
        // Orca's own restart continuation.
        'native-chat/agent-session-wire/structured-agent-session-restart-continuation.ts',
        'native-chat/agent-session-wire/structured-agent-session-restart-resume-wiring.ts',
        // The host's own `send`, which every path above reaches.
        'native-chat/agent-session-wire/structured-conversation-command-controller.ts',
        // The pointer lane's port, whose `send` is sendAgentTurn in structured-mailbox-pointer-host.
        'runtime/orchestration/structured-mailbox-pointer-delivery.ts',
        // Real-host test rigs the shared scan does not count as test files.
        'native-chat/agent-session-wire/structured-agent-session-rest-test-rig.ts',
        'acp/acp-structured-host.test-support.ts',
        // An Electron WebContents IPC send, not a chat.
        'browser/doc-preview-guest-policy.ts'
      ].sort()
    )
  })

  it('waits for a structured send to settle only in sendAgentTurn or the host itself', () => {
    expect(
      filesMatching(SEND_SETTLEMENT_WAIT),
      'A new send-then-wait block. Send an agent message through sendAgentTurn.'
    ).toEqual(
      [
        // The host exposing its waiter.
        'native-chat/agent-session-wire/structured-agent-session-host.ts',
        // A /compact command, not a message.
        'native-chat/agent-session-wire/structured-conversation-compaction.ts',
        // Orca's own restart continuation, which waits for hand-over and settlement separately.
        'native-chat/agent-session-wire/structured-agent-session-restart-resume-wiring.ts',
        'runtime/orchestration/send-agent-turn.ts',
        // The composer's RPC, which waits only for clients that predate pending replies.
        'runtime/rpc/methods/structured-agent-session-send-compatibility.ts'
      ].sort()
    )
  })

  it('types raw terminal text only from the listed paths', () => {
    expect(
      filesMatching(TERMINAL_WRITE),
      'A new direct sendTerminal use. Send an agent message through sendAgentTurn.'
    ).toEqual(
      [
        // Intended: a plugin's own terminal input, not a message on an agent's behalf.
        'plugins/plugin-host-service-bindings.ts',
        // Intended: Claude's agent-teams tmux `send-keys`, keystrokes the Claude CLI itself
        // issues; Orca relays them and is not the sender.
        'runtime/claude-agent-teams-tmux-dispatcher.ts',
        // Intended: the runtime lending its own write to that agent-teams relay.
        'runtime/orca-runtime-resolve-terminal-split-source-authority.ts',
        // Intended: a client's live keystroke stream, typed without Enter.
        'runtime/rpc/methods/terminal/terminal-input-delivery.ts',
        // Temporary: `terminal.send` into a terminal with no settled agent prompt, which may still
        // be an agent's message to another agent; moves with the `terminal.send` prompt above.
        'runtime/rpc/methods/terminal/terminal-send-method.ts'
      ].sort()
    )
  })

  it('launches with a prompt only from agent.launch', () => {
    // The launch-prompt helpers send any text into a chat or terminal; a new caller is a new sender.
    expect(
      filesMatching(
        /\b(?:commitStructuredAgentSessionLaunchPrompt|deliverTerminalAgentLaunchPrompt)\b/
      )
    ).toEqual(
      [
        'runtime/rpc/methods/agent-launch-structured-prompt.ts',
        'runtime/rpc/methods/agent-launch-terminal-prompt.ts',
        'runtime/rpc/methods/agent-launch-surfaces.ts'
      ].sort()
    )
  })

  it('pins the agent senders that use another primitive and are not moved yet', () => {
    // The terminal mail pointer: it types the text, then a separately gated Enter with durable
    // attempt states, which the prompt write does not do.
    expect(filesMatching(/\bwriteOrchestrationPointer(?:Pty|WithSettlement)\b/)).toEqual(
      [
        'runtime/orchestration/mailbox-pointer-pty-write.ts',
        'runtime/orca-runtime-write-orchestration-pointer-pty.ts',
        'runtime/orca-runtime-stop-requested-pty-ids.ts'
      ].sort()
    )
  })
})
