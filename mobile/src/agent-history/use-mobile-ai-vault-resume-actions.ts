import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { triggerError, triggerSuccess } from '../platform/haptics'
import {
  buildMobileAiVaultResumeEntry,
  buildMobileAiVaultResumeLaunch,
  createMobileAiVaultResumeMutationRegistry,
  resolveMobileAiVaultResumePlatform,
  resumeAiVaultSessionInTerminal,
  resumeAiVaultSessionViaHostArm,
  type MobileAiVaultResumeSettings
} from '../session/ai-vault-resume-launch'
import { prepareMobileAiVaultSessionResume } from '../session/ai-vault-resume-preparation'
import { resolveMobileResumeOutcomeDisplay } from '../session/ai-vault-resume-outcome'
import { loadMobileResumeMetadata } from './mobile-ai-vault-resume-metadata'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'
import { resolveMobileAiVaultSessionResumeTarget } from './agent-history-resume-target'

export type MobileAiVaultResumeActions = {
  resumingSessionId: string | null
  resumeMessage: string | null
  resumeFallbackSession: AiVaultSession | null
  onResumeSession: (session: AiVaultSession) => Promise<void>
  launchWithCurrentSettings: (session: AiVaultSession) => Promise<void>
}

export function useMobileAiVaultResumeActions(args: {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string
  hostPlatform: NodeJS.Platform | null
  hostTerminalWindowsShell: string | null
  activeWorktreeId: string
  worktrees: Worktree[]
}): MobileAiVaultResumeActions {
  const {
    client,
    connState,
    hostId,
    hostPlatform,
    hostTerminalWindowsShell,
    activeWorktreeId,
    worktrees
  } = args
  const router = useRouter()
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null)
  const [resumeMessage, setResumeMessage] = useState<string | null>(null)
  // Set only when the host reports invalid_launch_snapshot: the saved launch
  // details are gone, so we surface an explicit "Launch with current settings"
  // opt-in rather than silently substituting current config.
  const [resumeFallbackSession, setResumeFallbackSession] = useState<AiVaultSession | null>(null)
  const resumeLaunchInFlightRef = useRef(false)
  const resumeMutationRegistryRef = useRef(
    createMobileAiVaultResumeMutationRegistry(createMobileAiVaultResumeMutationId)
  )

  const navigateToResumedSession = useCallback(
    (targetWorktreeId: string): void => {
      router.push(
        `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(targetWorktreeId)}` as Parameters<
          typeof router.push
        >[0]
      )
    },
    [hostId, router]
  )

  // Shared prefix for both launch paths: fresh metadata + live target resolution.
  // `platform` is only needed by the current-settings fallback; the host-owned arm
  // ignores it (the host derives the command itself).
  const resolveResumeContext = useCallback(
    async (
      session: AiVaultSession
    ): Promise<{
      worktreeId: string
      platform: NodeJS.Platform | null
      settings: MobileAiVaultResumeSettings | null
      hasIdentityCapability: boolean
    } | null> => {
      if (!client) {
        return null
      }
      const {
        repos,
        folderWorkspaces,
        projectGroups,
        settings,
        worktrees: freshWorktrees,
        hasIdentityCapability
      } = await loadMobileResumeMetadata(client)
      const target = resolveMobileAiVaultSessionResumeTarget({
        session,
        activeWorktreeId,
        // Why: resolve against live worktrees so a workspace deleted or archived
        // since panel mount can't be picked; the mount-time list is only a
        // fallback when the fresh fetch fails.
        worktrees: freshWorktrees ?? worktrees,
        repos,
        folderWorkspaces,
        projectGroups
      })
      if (target.status !== 'ready') {
        setResumeMessage(target.message)
        triggerError()
        return null
      }
      return {
        worktreeId: target.worktreeId,
        platform: resolveMobileAiVaultResumePlatform(
          target.targetStatus,
          hostPlatform,
          target.workspacePath,
          target.terminalPlatform
        ),
        settings,
        hasIdentityCapability
      }
    },
    [activeWorktreeId, client, hostPlatform, worktrees]
  )

  // The legacy client-assembled resume: assemble the resume command for this
  // session id from the given settings and type it into a fresh terminal. Shared
  // by the explicit current-settings opt-in and by the legacy-host primary path
  // (a pre-identity host strips the agentLaunch arm, so the arm is unavailable).
  const runClientAssembledResume = useCallback(
    async (
      activeClient: RpcClient,
      session: AiVaultSession,
      context: {
        worktreeId: string
        platform: NodeJS.Platform | null
        settings: MobileAiVaultResumeSettings | null
      }
    ): Promise<void> => {
      if (!context.platform) {
        setResumeMessage('Unable to determine host platform.')
        triggerError()
        return
      }
      const preparedSession = await prepareMobileAiVaultSessionResume(activeClient, session)
      const launch = buildMobileAiVaultResumeLaunch({
        session: preparedSession,
        hostPlatform: context.platform,
        hostTerminalWindowsShell,
        settings: context.settings
      })
      await resumeAiVaultSessionInTerminal(activeClient, context.worktreeId, {
        ...launch,
        clientMutationId: resumeMutationRegistryRef.current.claim(session.id)
      })
      resumeMutationRegistryRef.current.releaseOnSuccess(session.id)
      triggerSuccess()
      setResumeMessage('Agent session queued.')
      setResumeFallbackSession(null)
      navigateToResumedSession(context.worktreeId)
    },
    [hostTerminalWindowsShell, navigateToResumedSession]
  )

  const onResumeSession = useCallback(
    async (session: AiVaultSession): Promise<void> => {
      if (resumeLaunchInFlightRef.current) {
        return
      }
      if (!client || connState !== 'connected') {
        setResumeMessage('Waiting for host...')
        triggerError()
        return
      }
      if (!session.sessionId) {
        setResumeMessage('This session is missing a resume id.')
        triggerError()
        return
      }

      resumeLaunchInFlightRef.current = true
      setResumingSessionId(session.id)
      setResumeMessage(null)
      setResumeFallbackSession(null)
      try {
        const context = await resolveResumeContext(session)
        if (!context) {
          return
        }
        // A pre-identity host strips the agentLaunch arm from createTerminal, which
        // would silently open a bare terminal with no resume and no error. Gate the
        // arm on the capability and fall back to the client-assembled resume (the
        // behavior every host still accepts) when it is absent.
        if (!context.hasIdentityCapability) {
          await runClientAssembledResume(client, session, context)
          return
        }
        // Host-owned resume-via-arm: echo the discovered identity and let the host
        // re-validate + assemble the command. No client command is ever a spawn input.
        const outcome = await resumeAiVaultSessionViaHostArm(client, context.worktreeId, {
          entry: buildMobileAiVaultResumeEntry(session),
          clientMutationId: resumeMutationRegistryRef.current.claim(session.id)
        })
        const display = resolveMobileResumeOutcomeDisplay(outcome)
        setResumeMessage(display.message)
        if (outcome.kind === 'launched') {
          resumeMutationRegistryRef.current.releaseOnSuccess(session.id)
          triggerSuccess()
          navigateToResumedSession(context.worktreeId)
          return
        }
        triggerError()
        // invalid_launch_snapshot is the only outcome offering an explicit
        // current-settings relaunch; Orca never substitutes it silently.
        if (display.action?.id === 'launch-current-settings') {
          // Why: the current-settings fallback sends a structurally different
          // createTerminal payload; reusing the failed arm's idempotency key
          // would trip host payload-conflict detection. Drop it so the fallback
          // claims a fresh key (the arm created nothing, so nothing to dedupe).
          resumeMutationRegistryRef.current.releaseOnSuccess(session.id)
          setResumeFallbackSession(session)
        }
      } catch (err) {
        triggerError()
        setResumeMessage(err instanceof Error ? err.message : 'Failed to resume session.')
      } finally {
        resumeLaunchInFlightRef.current = false
        setResumingSessionId(null)
      }
    },
    [client, connState, resolveResumeContext, runClientAssembledResume, navigateToResumedSession]
  )

  const launchWithCurrentSettings = useCallback(
    async (session: AiVaultSession): Promise<void> => {
      if (resumeLaunchInFlightRef.current) {
        return
      }
      if (!client || connState !== 'connected') {
        setResumeMessage('Waiting for host...')
        triggerError()
        return
      }

      resumeLaunchInFlightRef.current = true
      setResumingSessionId(session.id)
      setResumeMessage(null)
      try {
        const context = await resolveResumeContext(session)
        if (!context) {
          return
        }
        // Explicit user opt-in: assemble the resume command from CURRENT settings
        // because the host reported the saved launch snapshot is no longer usable.
        await runClientAssembledResume(client, session, context)
      } catch (err) {
        triggerError()
        setResumeMessage(err instanceof Error ? err.message : 'Failed to resume session.')
      } finally {
        resumeLaunchInFlightRef.current = false
        setResumingSessionId(null)
      }
    },
    [client, connState, resolveResumeContext, runClientAssembledResume]
  )

  return {
    resumingSessionId,
    resumeMessage,
    resumeFallbackSession,
    onResumeSession,
    launchWithCurrentSettings
  }
}

function createMobileAiVaultResumeMutationId(sessionId: string): string {
  const sessionPart = sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64) || 'session'
  const randomPart = Math.random().toString(36).slice(2, 10)
  return `ai-vault-resume:${sessionPart}:${Date.now().toString(36)}:${randomPart}`
}
