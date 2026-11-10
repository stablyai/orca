import { useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useHostClient } from '../transport/connection/host-client-hooks'
import type { CloudWorkspace } from './cloud-control-plane-client'
import { cloudDeviceLabel } from './cloud-device-label'
import {
  deliverQueuedCloudPrompts,
  listQueuedCloudPrompts,
  markWaitingCloudPromptsFailed,
  requeueUnsentCloudPrompts
} from './cloud-prompt-queue'
import {
  forgetRevokedCloudSession,
  loadCloudControlPlane,
  useCloudHostRemoval
} from './cloud-session'
import {
  CloudAttachError,
  attachCloudWorkspace,
  type CloudAttachPhase
} from './cloud-workspace-attach'
import {
  attachErrorMessage,
  cloudPromptErrorCode,
  cloudPromptErrorMessage,
  phaseLabel
} from './cloud-workspace-copy'
import {
  ensureCloudProjectWorktree,
  launchCloudPrompt,
  type CloudLaunchedAgent
} from './cloud-workspace-host-operations'
import { roleForCloudError } from './cloud-entitlement-copy'
import { cloudWorkspaceProjectRoot, recordCloudWorkspaceHost } from './cloud-workspace-links'
import { removeHostAndCloseClient } from '../transport/hosts/host-removal-lifecycle'
import { useInvalidateCloudWorkspaces } from './use-cloud-workspaces'

export type CloudWorkspaceRun =
  | { kind: 'idle' }
  | { kind: 'attaching'; phase: CloudAttachPhase; startedAt: number; intent: 'open' | 'send' }
  | { kind: 'delivering'; hostId: string; startedAt: number; connectBy: number }
  | { kind: 'error'; message: string; retry: 'open' | 'send' | null }
  | { kind: 'launched'; hostId: string; worktreeId: string; agent: CloudLaunchedAgent }

// A paired VM that never reaches `connected` must end in an error the user can retry, not a spinner.
const DELIVERY_CONNECT_DEADLINE_MS = 30_000

/** Wake → per-device grant → direct E2EE pairing → deliver queued prompts → land in the session. */
export function useCloudWorkspaceRun(sandboxId: string, workspace: CloudWorkspace | null) {
  const t = useMobileTranslation()
  const router = useRouter()
  const removal = useCloudHostRemoval()
  const invalidate = useInvalidateCloudWorkspaces()
  const [run, setRun] = useState<CloudWorkspaceRun>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const deliveryStarted = useRef<CloudWorkspaceRun | null>(null)
  const inFlight = useRef(false)
  const host = useHostClient(run.kind === 'delivering' ? run.hostId : undefined)
  const active = run.kind === 'attaching' || run.kind === 'delivering'
  const title = workspace?.title ?? ''

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  // VoiceOver and TalkBack hear each step and any failure once, not every timer tick.
  useEffect(() => {
    if (run.kind === 'attaching') {
      AccessibilityInfo.announceForAccessibility(phaseLabel(run.phase, t))
    } else if (run.kind === 'error') {
      AccessibilityInfo.announceForAccessibility(run.message)
    }
  }, [run, t])

  useEffect(() => {
    if (
      run.kind !== 'delivering' ||
      host.state === 'connected' ||
      deliveryStarted.current === run
    ) {
      return
    }
    const hostId = run.hostId
    // A pairing the VM refuses (revoked, rebuilt) is dropped so the next try gets a fresh grant; a
    // slow network keeps it, so retries don't pile up devices on the sandbox.
    const giveUp = (forget: boolean) => {
      if (forget) {
        void recordCloudWorkspaceHost(sandboxId, null)
        void removeHostAndCloseClient(hostId, removal.forgetHostClient, removal.queryClient).catch(
          () => undefined
        )
      }
      void markWaitingCloudPromptsFailed(sandboxId, 'not_connected').catch(() => undefined)
      setRun({
        kind: 'error',
        message: attachErrorMessage(new CloudAttachError('pairing_failed'), t),
        retry: 'send'
      })
    }
    if (host.state === 'auth-failed') {
      giveUp(true)
      return
    }
    // One deadline per run, not per state change: a flapping connection still ends.
    const timer = setTimeout(() => giveUp(false), Math.max(0, run.connectBy - Date.now()))
    return () => clearTimeout(timer)
  }, [run, host.state, t, sandboxId, removal])

  useEffect(() => {
    // One delivery per run: a re-render must never launch the same prompts twice.
    if (
      run.kind !== 'delivering' ||
      !host.client ||
      host.state !== 'connected' ||
      deliveryStarted.current === run
    ) {
      return
    }
    deliveryStarted.current = run
    const client = host.client
    const hostId = run.hostId
    void (async () => {
      try {
        const waiting = await listQueuedCloudPrompts(sandboxId)
        if (!waiting.some((prompt) => prompt.status !== 'failed')) {
          // Nothing to send: the connection is proven, so open the sandbox's workspaces.
          if (mountedRef.current) {
            setRun({ kind: 'idle' })
            router.push(`/h/${hostId}`)
          }
          return
        }
        const projectRoot = (await cloudWorkspaceProjectRoot(sandboxId)) ?? undefined
        const worktreeId = await ensureCloudProjectWorktree(client, projectRoot)
        const launches: CloudLaunchedAgent[] = []
        let failed = 0
        // Prompts typed while this ran are picked up too, so none is left "waiting" behind it.
        for (let round = 0; round < 5; round++) {
          const next = await deliverQueuedCloudPrompts(
            sandboxId,
            async (prompt) => {
              launches.push(await launchCloudPrompt(client, worktreeId, prompt))
            },
            cloudPromptErrorCode
          )
          failed += next.failed.length
          const pending = await listQueuedCloudPrompts(sandboxId)
          if (
            next.delivered + next.failed.length === 0 ||
            !pending.some((prompt) => prompt.status !== 'failed')
          ) {
            break
          }
        }
        invalidate()
        if (!mountedRef.current) {
          return
        }
        if (failed > 0) {
          const stillQueued = (await listQueuedCloudPrompts(sandboxId)).some(
            (prompt) => prompt.status !== 'failed'
          )
          setRun({
            kind: 'error',
            message: t(
              'cloud.error.deliver',
              'The workspace is running, but a prompt didn’t start. Your files are safe.'
            ),
            retry: stillQueued ? 'send' : null
          })
          return
        }
        const last = launches[launches.length - 1]
        if (last) {
          // A cloud agent may still need its sign-in: say what happened before dropping into the
          // session, and let the user pick the chat or the terminal.
          setRun({ kind: 'launched', hostId, worktreeId, agent: last })
          return
        }
        setRun({ kind: 'idle' })
        router.push(`/h/${hostId}`)
      } catch (error) {
        if (mountedRef.current) {
          // Delivery failures are about the prompt, not the sandbox: say which, never "something".
          setRun({
            kind: 'error',
            message: cloudPromptErrorMessage(cloudPromptErrorCode(error), t),
            retry: 'send'
          })
        }
      }
    })()
  }, [run, host.client, host.state, sandboxId, invalidate, router, t, title])

  const start = useCallback(
    async (intent: 'open' | 'send') => {
      // A ref, not state: a second tap in the same frame must not start a second grant.
      if (!workspace || active || inFlight.current) {
        return
      }
      inFlight.current = true
      const plane = await loadCloudControlPlane()
      if (!plane) {
        inFlight.current = false
        router.replace('/')
        return
      }
      // Prompts held back by an earlier failed attach go out with this one, whichever button started it.
      await requeueUnsentCloudPrompts(sandboxId).catch(() => undefined)
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const startedAt = Date.now()
      setRun({ kind: 'attaching', phase: 'waking', startedAt, intent })
      try {
        const { hostId } = await attachCloudWorkspace({
          plane,
          sandboxId,
          title: workspace.title,
          deviceLabel: cloudDeviceLabel(),
          signal: controller.signal,
          onPhase: (phase) =>
            setRun((current) =>
              current.kind === 'attaching' && current.phase !== phase
                ? { ...current, phase }
                : current
            )
        })
        invalidate()
        if (controller.signal.aborted || !mountedRef.current) {
          return
        }
        // Opening also waits for the sandbox's orcad to accept this phone, so a stale pairing ends in
        // a retryable error here rather than on a dead host screen.
        setRun({
          kind: 'delivering',
          hostId,
          startedAt,
          connectBy: Date.now() + DELIVERY_CONNECT_DEADLINE_MS
        })
      } catch (error) {
        if (controller.signal.aborted || !mountedRef.current) {
          return
        }
        await forgetRevokedCloudSession(error, removal)
        // Prompts that were going out with this attach now say so, instead of "waiting".
        await markWaitingCloudPromptsFailed(sandboxId, 'not_connected').catch(() => undefined)
        const role = await roleForCloudError(error, plane, controller.signal)
        if (controller.signal.aborted || !mountedRef.current) {
          return
        }
        setRun({ kind: 'error', message: attachErrorMessage(error, t, role), retry: intent })
        invalidate()
      } finally {
        inFlight.current = false
      }
    },
    [workspace, active, router, sandboxId, invalidate, t, removal]
  )

  const openSession = useCallback(
    (view: 'chat' | 'terminal') => {
      if (run.kind !== 'launched') {
        return
      }
      // The worktree already exists, so no `created=1` (it would auto-create a blank terminal).
      const params = new URLSearchParams({ name: title })
      const paneKey = view === 'terminal' ? run.agent.paneKey : undefined
      if (paneKey) {
        params.set('paneKey', paneKey)
      }
      setRun({ kind: 'idle' })
      router.push(
        `/h/${encodeURIComponent(run.hostId)}/session/${encodeURIComponent(run.worktreeId)}?${params}`
      )
    },
    [run, router, title]
  )

  const fail = useCallback((message: string) => setRun({ kind: 'error', message, retry: null }), [])
  const clearError = useCallback(
    () => setRun((current) => (current.kind === 'error' ? { kind: 'idle' } : current)),
    []
  )
  return { run, active, start, fail, clearError, openSession }
}
