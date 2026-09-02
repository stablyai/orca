// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStartTuiIdleVisibleReadProbe } from './orca-runtime-start-tui-idle-visible-read-probe'
import { join } from 'node:path'
import type { StructuredTuiOwner } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { readCodexResumeProcessIdentity } from '../codex/codex-resume-process-proof'
import { readStructuredTuiProcessIdentity } from './structured-tui-process-identity'
import { codexProviderHandleLink } from '../codex/codex-structured-owner-identity'
import { claudeProviderHandleLink } from '../claude/claude-structured-owner-identity'
import { StructuredTuiLaunchCleanupError } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'

export class OrcaRuntimeWithStructuredAgentSessionLaunchTui extends OrcaRuntimeWithStartTuiIdleVisibleReadProbe {
  protected createStructuredAgentSessionLaunchTuiCallback() {
    return async ({ record, fence, spawnToken, onSpawned }) => {
      const head = record.providerHandleChain.at(-1)
      if (!head || (head.handle.provider !== 'codex' && head.handle.provider !== 'claude')) {
        throw new Error('agent_session_identity_required')
      }
      const provider = head.handle.provider
      const providerSessionId = provider === 'claude' ? head.handle.sessionId : head.handle.threadId
      const launchStartedAt = Date.now()
      const launched = await this.ensureAgentSession(
        {
          kind: 'explicit',
          worktree: `id:${record.location.workspaceId}`,
          agent: provider,
          providerSession: { key: 'session_id', id: providerSessionId },
          ...(record.options ? { launchPreferences: record.options } : {}),
          presentation: 'background'
        },
        {},
        { spawnToken, providerRoot: record.accountHome.path, sessionId: record.sessionId }
      )
      const terminal = launched.terminal
      let spawnedOwner: StructuredTuiOwner | null = null
      let ptyId: string | undefined
      try {
        if (!terminal.processId || !terminal.paneKey || !terminal.tabId || !terminal.ptyId) {
          throw new Error('The resumed terminal did not publish a process identity.')
        }
        ptyId = terminal.ptyId
        spawnedOwner = this.refreshStructuredTuiOwnerBinding({
          terminal: {
            handle: terminal.handle,
            tabId: terminal.tabId,
            paneKey: terminal.paneKey,
            ptyId: terminal.ptyId
          },
          process:
            provider === 'codex'
              ? await readCodexResumeProcessIdentity({
                  hostId: record.location.executionHostId,
                  rootPid: terminal.processId,
                  spawnToken,
                  threadId: head.handle.threadId
                })
              : await readStructuredTuiProcessIdentity({
                  hostId: record.location.executionHostId,
                  rootPid: terminal.processId,
                  spawnToken,
                  agent: provider
                }),
          link:
            provider === 'codex'
              ? codexProviderHandleLink({
                  threadId: head.handle.threadId,
                  resumed: true,
                  fence,
                  observedAt: Date.now()
                })
              : claudeProviderHandleLink({
                  sessionId: head.handle.sessionId,
                  leafUuid: head.handle.leafUuid,
                  resumed: true,
                  fence,
                  observedAt: Date.now()
                })
        })
        await onSpawned?.(spawnedOwner)
        await this.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 30000 })
        const proof =
          provider === 'codex'
            ? await this.waitForAdoptedStructuredTuiProof({
                owner: spawnedOwner,
                threadId: head.handle.threadId,
                codexHome: record.accountHome.path
              })
            : await this.waitForStructuredClaudeTuiProof({
                handle: terminal.handle,
                paneKey: terminal.paneKey,
                sessionId: head.handle.sessionId,
                previousLeafUuid: head.handle.leafUuid,
                projectsDir: join(record.accountHome.path, 'projects'),
                spawnToken,
                minimumProviderSessionReceivedAt: launchStartedAt
              })
        const revealed = await this.focusTerminal(terminal.handle)
        return this.refreshStructuredTuiOwnerBinding({
          ...spawnedOwner,
          link:
            provider === 'claude'
              ? claudeProviderHandleLink({
                  sessionId: head.handle.sessionId,
                  leafUuid: proof.leafUuid ?? head.handle.leafUuid,
                  resumed: true,
                  fence,
                  observedAt: Date.now()
                })
              : spawnedOwner.link,
          terminal: {
            handle: terminal.handle,
            tabId: revealed.tabId,
            paneKey: terminal.paneKey,
            ptyId: terminal.ptyId
          },
          process: spawnedOwner.process,
          ...(proof.transcriptPath ? { transcriptPath: proof.transcriptPath } : {}),
          historySource: 'provider-resume'
        })
      } catch (error) {
        let closeError: unknown = null
        try {
          await this.closeTerminal(terminal.handle)
        } catch (cleanupFailure) {
          closeError = cleanupFailure
        }
        try {
          if (spawnedOwner) {
            await this.waitForStructuredTuiOwnerExit(spawnedOwner)
          } else if (ptyId) {
            await this.waitForStructuredTuiPtyExit(ptyId)
          } else {
            throw new Error('The failed terminal did not publish a PTY identity.')
          }
        } catch (exitFailure) {
          throw new StructuredTuiLaunchCleanupError(
            error,
            closeError === null
              ? exitFailure
              : new AggregateError(
                  [closeError, exitFailure],
                  'Structured TUI cleanup could not prove process exit.'
                )
          )
        }
        throw error
      }
    }
  }
}
