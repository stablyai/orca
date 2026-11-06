import { isTerminalInputPaused } from '../../../terminal/input/terminal-input-admission'
import { wrapTerminalBracketedPasteText } from '../../../../../shared/terminal/input/terminal-bracketed-paste-text'
import { getWindowsInputRecordPasteBurstMs } from '../../../../../shared/agent-launch/startup/agent-prompt-injection'
import { defineMethod } from '../../core'
import {
  TerminalViewCodexAgent,
  type CodexAgentViewResult
} from '../../../../../shared/rpc-contract/terminal-codex-agent-view-params'
import { agentHookServer } from '../../../../agent-hooks/server'
import { assertTerminalAgentSendable } from '../../terminal-agent-send-guard'
import {
  assertTerminalSendExactPtyBinding,
  terminalInputSourceForClient
} from './terminal-input-delivery'
import {
  codexSubagentPickerKeys,
  readCodexSubagentPicker,
  showsCodexSubagent,
  type CodexSubagentPickerRow
} from '../../../../codex/codex-subagent-picker-screen'

const PICKER_WAIT_MS = 3000
// Codex redraws within a frame or two; slower polling only adds to the switch.
const POLL_MS = 15
const ESCAPE = '\x1b'

// One switch per pane at a time: interleaved picker keystrokes would select the wrong thread.
const switching = new Map<string, Promise<unknown>>()
const latest = new Map<string, number>()
let nextGeneration = 0

export const TERMINAL_CODEX_AGENT_VIEW_METHODS = [
  defineMethod({
    name: 'terminal.viewCodexAgent',
    permission: 'workspace',
    params: TerminalViewCodexAgent,
    handler: async (params, { runtime, signal }): Promise<{ view: CodexAgentViewResult }> => {
      const inputSource = terminalInputSourceForClient(params.client)
      const ptyId = runtime.resolveLiveLeafForHandle(params.terminal)?.ptyId
      const paneKey = runtime.getLiveTerminalPaneKey(params.terminal)
      if (!ptyId || !paneKey) {
        return { view: { status: 'unavailable' } }
      }
      const generation = ++nextGeneration
      latest.set(paneKey, generation)
      const previous = switching.get(paneKey) ?? Promise.resolve()
      const run = previous
        .catch(() => {})
        .then(async (): Promise<CodexAgentViewResult> => {
          // Cleanup writes keep these checks but outlive aborts and session-row flicker.
          const assertOwned = () => {
            assertTerminalSendExactPtyBinding(runtime, params.terminal, ptyId)
            if (isTerminalInputPaused(runtime, ptyId, inputSource)) {
              throw new Error('terminal_guard_not_writable')
            }
          }
          const assertCurrent = () => {
            signal?.throwIfAborted()
            assertOwned()
            if (
              !agentHookServer
                .getStatusSnapshotForPane(paneKey)
                .some(
                  (row) =>
                    row.agentType === 'codex' &&
                    !row.structuredHost &&
                    row.providerSession?.id === params.sessionId
                )
            ) {
              throw new Error('terminal_guard_not_writable')
            }
          }
          const screen = () => runtime.readTerminal(params.terminal, { screen: true })
          const send = async (
            text: string,
            assertWritable = assertCurrent,
            assertStillValid?: () => Promise<void>
          ) => {
            // Rechecked at write time: a queued key must never answer an approval prompt.
            const assertSendable = () =>
              assertTerminalAgentSendable({ runtime, handle: params.terminal, assertWritable })
            await assertSendable()
            const sent = await runtime.sendTerminal(
              params.terminal,
              { text, enter: false },
              {
                inputKind: 'driving',
                inputSource,
                ...(assertWritable === assertCurrent ? { signal } : {}),
                beforeWrite: async () => {
                  await assertSendable()
                  await assertStillValid?.()
                }
              }
            )
            if (!sent.accepted) {
              throw new Error('terminal_guard_not_writable')
            }
          }
          const waitFor = async <T>(probe: (lines: string[]) => T | null): Promise<T | null> => {
            const deadline = Date.now() + PICKER_WAIT_MS
            while (true) {
              assertCurrent()
              const found = probe((await screen()).tail)
              if (found !== null || Date.now() > deadline) {
                return found
              }
              await new Promise((resolve) => setTimeout(resolve, POLL_MS))
            }
          }
          const closePickerIfOpen = async () => {
            const now = await screen()
            if (now.source === 'screen' && readCodexSubagentPicker(now.tail)) {
              await send(ESCAPE, assertOwned)
            }
          }
          // A newer click for this pane replaces any switch still waiting its turn.
          if (latest.get(paneKey) !== generation) {
            return { status: 'unavailable' }
          }
          assertCurrent()
          const before = await screen()
          // A stream fallback has no rendered composer, so a draft could not be ruled out.
          if (before.source !== 'screen') {
            return { status: 'unavailable' }
          }
          if (params.agentId === undefined && !showsCodexSubagent(before.tail)) {
            return { status: 'viewed' }
          }
          // The picker opens through the composer; a draft there would be submitted with it.
          if (before.draft?.trim()) {
            return { status: 'draft' }
          }
          try {
            if (!readCodexSubagentPicker(before.tail)) {
              // A framed paste ends explicitly, so Enter submits at once instead of joining a paste burst.
              await send(wrapTerminalBracketedPasteText('/subagents'))
              // Windows Codex reads the paste as key events and keeps a mid-burst Enter as a newline.
              const burstMs = getWindowsInputRecordPasteBurstMs(
                process.platform,
                'codex',
                '/subagents'
              )
              if (burstMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, burstMs))
              }
              await send('\r')
            }
            const rows = await waitFor(readCodexSubagentPicker)
            if (!rows) {
              return { status: 'unavailable' }
            }
            const target = (params.agentId ?? params.sessionId).toLowerCase()
            const keysFor = (current: CodexSubagentPickerRow[] | null) => {
              const row = current?.find((candidate) => candidate.threadId === target)
              return current && row ? codexSubagentPickerKeys(current, row) : null
            }
            const keys = keysFor(rows)
            if (!keys) {
              return { status: 'not_listed' }
            }
            await send(keys, assertCurrent, async () => {
              if (keysFor(readCodexSubagentPicker((await screen()).tail)) !== keys) {
                throw new Error('terminal_guard_not_writable')
              }
            })
            const wantsChild = params.agentId !== undefined
            const switched = await waitFor((lines) =>
              !readCodexSubagentPicker(lines) && showsCodexSubagent(lines) === wantsChild
                ? true
                : null
            )
            return { status: switched ? 'viewed' : 'unavailable' }
          } finally {
            // Never leave the picker up: the next keystroke the user types would pick a row.
            await closePickerIfOpen().catch(() => {})
          }
        })
      switching.set(paneKey, run)
      try {
        return { view: await run }
      } catch (error) {
        if (error instanceof Error && error.message === 'terminal_guard_permission') {
          return { view: { status: 'permission' } }
        }
        return { view: { status: 'unavailable' } }
      } finally {
        if (switching.get(paneKey) === run) {
          switching.delete(paneKey)
        }
        if (latest.get(paneKey) === generation) {
          latest.delete(paneKey)
        }
      }
    }
  })
]
