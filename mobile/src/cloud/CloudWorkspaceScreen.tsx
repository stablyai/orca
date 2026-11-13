import { useRouter } from 'expo-router'
import { Cloud } from 'lucide-react-native'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ListRow } from '../components/list/ListGroup'
import { MobileStateView } from '../components/MobileStateView'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { structuredSessionOperationId } from '../session/native-chat/agent-session/structured-session-operation-id'
import { SettingsNavBar } from '../settings/settings-screen-frame'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { CloudAgentStartedCard } from './CloudAgentStartedCard'
import { CloudErrorBanner } from './CloudErrorBanner'
import { CloudPromptComposer } from './CloudPromptComposer'
import { CloudPromptQueueSection } from './CloudPromptQueueSection'
import { CloudReadSnapshotSection } from './CloudReadSnapshotSection'
import { CloudStateGlyph } from './CloudStateGlyph'
import { CloudStatusCard } from './CloudStatusCard'
import { CloudWorkspaceActions } from './CloudWorkspaceActions'
import {
  archiveCloudWorkspace,
  restartCloudWorkspace,
  sleepCloudWorkspace
} from './cloud-control-plane-client'
import { CloudRequestError } from './cloud-control-plane-request'
import {
  enqueueCloudPrompt,
  listQueuedCloudPrompts,
  subscribeCloudPromptQueue,
  type QueuedCloudPrompt
} from './cloud-prompt-queue'
import {
  forgetRevokedCloudSession,
  loadCloudControlPlane,
  useCloudHostRemoval
} from './cloud-session'
import { attachErrorMessage, phaseLabel } from './cloud-workspace-copy'
import { setCloudReturnTo } from './cloud-return-to'
import { cloudMissingState } from './cloud-screen-states'
import { cloudRepoLine } from './cloud-workspace-display'
import {
  cloudScrollBottomPadding,
  cloudWorkspaceScreenStyles as styles
} from './cloud-workspace-screen-styles'
import { CloudReadSnapshotRefusedError } from './cloud-read-snapshot'
import { useCloudReadSnapshot } from './use-cloud-read-snapshot'
import { useCloudWorkspaceRun, type CloudWorkspaceRun } from './use-cloud-workspace-run'
import {
  useCloudEnrollment,
  useCloudWorkspace,
  useCloudWorkspaceLiveStatus,
  useInvalidateCloudWorkspaces
} from './use-cloud-workspaces'
import { ORCA_CLOUD_SANDBOX_SPEC } from '../../../src/shared/hosted-sandbox/hosted-sandbox-wire'

export function CloudWorkspaceScreen({
  sandboxId,
  autostart = false
}: {
  sandboxId: string
  autostart?: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const removal = useCloudHostRemoval()
  const enrollment = useCloudEnrollment()
  const listed = useCloudWorkspace(enrollment, sandboxId)
  const { isPending, isFetching, isError, refetch } = listed
  const live = useCloudWorkspaceLiveStatus(sandboxId, listed.workspace?.status === 'running')
  // The registry only knows "running"; the live status knows when it is up but not answering.
  const workspace =
    listed.workspace?.status === 'running' && live.data?.state === 'unresponsive'
      ? { ...listed.workspace, status: 'unresponsive' as const }
      : listed.workspace
  // Asleep: read its last sealed snapshot instead of waking it. Nothing here ever wakes it.
  const asleep = workspace?.status === 'sleeping'
  const snapshot = useCloudReadSnapshot(sandboxId, asleep, workspace?.readSnapshotAt ?? null)
  const signerChanged =
    snapshot.data?.state === 'error' &&
    snapshot.data.error instanceof CloudReadSnapshotRefusedError &&
    snapshot.data.error.reason === 'signer_changed'
  const invalidate = useInvalidateCloudWorkspaces()
  const { run, active, start, fail, clearError, openSession } = useCloudWorkspaceRun(
    sandboxId,
    workspace
  )
  const [queue, setQueue] = useState<QueuedCloudPrompt[]>([])
  // The run as it was when wake was tapped: until the run moves on (start() first reads the
  // keychain), the button already reads Waking rather than keeping "Wake to continue".
  const [wakeTappedAt, setWakeTappedAt] = useState<CloudWorkspaceRun | null>(null)
  const wakePending = wakeTappedAt !== null && wakeTappedAt === run
  const [busyAction, setBusyAction] = useState<'sleep' | 'archive' | 'restart' | null>(null)

  useEffect(() => {
    const load = () =>
      void listQueuedCloudPrompts(sandboxId)
        .then(setQueue)
        .catch(() => setQueue([]))
    load()
    return subscribeCloudPromptQueue(load)
  }, [sandboxId])

  // Arriving from "New cloud workspace": carry straight on to pairing and the first prompt.
  const autostarted = useRef(false)
  useEffect(() => {
    if (autostart && !autostarted.current && workspace) {
      autostarted.current = true
      void start('send')
    }
  }, [autostart, workspace, start])

  const send = useCallback(
    async (text: string, agent: string): Promise<boolean> => {
      try {
        await enqueueCloudPrompt({
          sandboxId,
          text,
          agent,
          operationId: structuredSessionOperationId()
        })
      } catch (error) {
        fail(
          error instanceof Error && error.message === 'cloud_prompt_queue_full'
            ? t('cloud.error.queueFull', 'Too many prompts are waiting. Send or remove some first.')
            : t('cloud.error.generic', 'Something went wrong. Your files are safe.')
        )
        return false
      }
      void start('send')
      return true
    },
    [sandboxId, start, fail, t]
  )

  const lifecycle = useCallback(
    async (action: 'sleep' | 'archive' | 'restart') => {
      const plane = await loadCloudControlPlane()
      if (!plane || !workspace) {
        return
      }
      clearError()
      setBusyAction(action)
      try {
        if (action === 'restart') {
          await restartCloudWorkspace(plane, workspace.id)
        } else if (action === 'sleep') {
          await sleepCloudWorkspace(plane, workspace.id)
        } else {
          await archiveCloudWorkspace(plane, workspace.id)
          router.back()
        }
      } catch (error) {
        await forgetRevokedCloudSession(error, removal)
        fail(
          action === 'restart' && error instanceof CloudRequestError && error.status === 404
            ? t(
                'cloud.error.restartOwner',
                'Only the workspace’s owner can restart it. Your files are safe.'
              )
            : action === 'archive' && error instanceof CloudRequestError && error.status === 404
              ? t(
                  'cloud.error.archiveUnavailable',
                  'Archiving isn’t available yet. Put it to sleep instead.'
                )
              : attachErrorMessage(error, t)
        )
      } finally {
        setBusyAction(null)
        invalidate()
      }
    },
    [workspace, clearError, router, removal, fail, t, invalidate]
  )

  if (!workspace) {
    const missing = cloudMissingState({ enrollment, isPending, isFetching, isError })
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <SettingsNavBar
          title={t('cloud.workspace.title', 'Cloud workspace')}
          onBack={() => router.back()}
        />
        <View style={styles.centered}>
          {missing === 'signin' ? (
            // A share link opened on a phone that isn't connected yet: the list query never runs.
            // Same layout as the asleep host (DS-27 polish): glyph, title, one sentence, one button.
            <MobileStateView
              iconElement={<CloudStateGlyph />}
              title={t('cloud.workspace.signIn', 'Sign in to Orca Cloud on this phone')}
              message={t(
                'cloud.workspace.signInDetail',
                'This link opens a cloud workspace your team shared. Sign in to see it.'
              )}
              action={{
                label: t('cloud.workspace.signInAction', 'Sign in'),
                onPress: () => {
                  // Connect on Home, then come straight back to this workspace.
                  setCloudReturnTo(`/cloud/${sandboxId}`)
                  router.replace('/')
                }
              }}
            />
          ) : missing === 'loading' ? (
            <ActivityIndicator color={colors.textMuted} />
          ) : (
            <>
              <Text style={styles.emptyText}>
                {missing === 'unreachable'
                  ? t(
                      'cloud.workspace.unreachable',
                      'Couldn’t reach Orca Cloud. Check your connection and try again.'
                    )
                  : t(
                      'cloud.workspace.missing',
                      'This workspace is gone or you no longer have access.'
                    )}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void refetch()}
                style={styles.linkButton}
              >
                <Text style={styles.link}>{t('common.tryAgain', 'Try again')}</Text>
              </Pressable>
            </>
          )}
        </View>
      </SafeAreaView>
    )
  }

  // Up either way: a prompt sent now goes out without a wake.
  const awake = workspace.status === 'running' || workspace.status === 'unresponsive'
  const unavailable =
    workspace.status === 'creating' ||
    workspace.status === 'stopping' ||
    workspace.status === 'deleting' ||
    workspace.status === 'archived'
  const waking =
    wakePending ||
    run.kind === 'attaching' ||
    run.kind === 'delivering' ||
    workspace.status === 'waking'
  // Asleep, or waking from it: the read-only copy stays readable (header says Waking) until it opens.
  const showSnapshot = asleep || (waking && !awake && snapshot.data !== undefined)
  // Up but not answering: the one thing that helps is a restart (glossary "Restarting").
  const restartable = workspace.status === 'unresponsive' && run.kind !== 'launched' && !active
  const busy = active || wakePending || busyAction === 'restart'
  const primaryLabel = wakePending
    ? phaseLabel('waking', t)
    : run.kind === 'launched'
      ? t('cloud.action.openSession', 'Open session')
      : run.kind === 'attaching'
        ? phaseLabel(run.phase, t)
        : run.kind === 'delivering'
          ? t('cloud.phase.delivering', 'Starting your agent')
          : workspace.status === 'creating'
            ? t('cloud.action.settingUp', 'Starting…')
            : workspace.status === 'archived'
              ? t('cloud.status.archived', 'Archived')
              : workspace.status === 'deleting'
                ? t('cloud.status.deleting', 'Deleting')
                : busyAction === 'restart'
                  ? t('cloud.status.restarting', 'Restarting')
                  : restartable
                    ? t('cloud.action.restart', 'Restart sandbox')
                    : awake
                      ? t('cloud.action.open', 'Open workspace')
                      : asleep
                        ? t('cloud.action.wakeToContinue', 'Wake to continue')
                        : t('cloud.action.wakeOpen', 'Wake and open workspace')
  const primaryDisabled = busy || unavailable

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <SettingsNavBar
          title={workspace.title}
          // The cloud-icon rule: a bare, muted Cloud that never changes with state (the card says it).
          titleIcon={<Cloud size={14} strokeWidth={2} color={colors.textMuted} />}
          onBack={() => router.back()}
        />
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingBottom: cloudScrollBottomPadding(insets.bottom) }
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <CloudStatusCard
            workspace={workspace}
            run={run}
            usage={live.data?.usage ?? null}
            uptimeMs={live.data?.uptimeMs ?? null}
            promptsWaiting={queue.some((prompt) => prompt.status !== 'failed')}
          />
          {run.kind === 'launched' ? (
            <CloudAgentStartedCard
              agent={run.agent.agent}
              onOpenTerminal={run.agent.paneKey ? () => openSession('terminal') : null}
            />
          ) : null}
          {run.kind === 'error' ? (
            <CloudErrorBanner
              message={run.message}
              onRetry={run.retry ? () => void start(run.retry ?? 'open') : null}
            />
          ) : null}
          {showSnapshot ? (
            <CloudReadSnapshotSection
              waking={waking}
              result={snapshot.data}
              fetchedAt={snapshot.dataUpdatedAt}
              loading={
                snapshot.isPending || (snapshot.isFetching && snapshot.data?.state === 'error')
              }
              onRetry={() => void snapshot.refetch()}
            />
          ) : null}

          {/* Archived is read-only here: nothing can wake it from the phone, so no prompt box. */}
          {workspace.status === 'archived' ? null : (
            <View style={styles.section}>
              <Text style={styles.sectionHeading} accessibilityRole="header">
                {t('cloud.prompt.heading', 'Ask an agent')}
              </Text>
              <CloudPromptComposer
                awake={awake}
                waking={active || workspace.status === 'waking'}
                disabled={unavailable}
                onSend={send}
              />
            </View>
          )}
          <CloudPromptQueueSection queue={queue} awake={awake} onRetry={() => void start('send')} />

          <View style={styles.section}>
            <Text style={styles.sectionHeading} accessibilityRole="header">
              {t('cloud.details.heading', 'Details')}
            </Text>
            <View style={styles.card}>
              {cloudRepoLine(workspace) ? (
                <ListRow
                  key="repo"
                  title={t('cloud.details.repo', 'Repository')}
                  value={cloudRepoLine(workspace) ?? ''}
                />
              ) : null}
              {cloudRepoLine(workspace) ? <View style={styles.detailDivider} /> : null}
              <ListRow
                key="machine"
                title={t('cloud.details.machine', 'Sandbox size')}
                value={t('cloud.size.spec', '{{vcpus}} vCPU · {{memoryGb}} GB', {
                  vcpus: String(ORCA_CLOUD_SANDBOX_SPEC.vcpus),
                  memoryGb: String(ORCA_CLOUD_SANDBOX_SPEC.memoryGb)
                })}
              />
            </View>
          </View>

          <CloudWorkspaceActions
            workspace={workspace}
            busy={busyAction === 'restart' ? null : busyAction}
            disabled={active || busyAction !== null}
            onSleep={() => void lifecycle('sleep')}
            onArchive={() => void lifecycle('archive')}
          />
        </ScrollView>

        <View style={[styles.actionBar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: primaryDisabled, busy }}
            disabled={primaryDisabled}
            onPress={() => {
              if (run.kind === 'launched') {
                openSession('chat')
                return
              }
              if (restartable) {
                void lifecycle('restart')
                return
              }
              setWakeTappedAt(run)
              // A changed snapshot signer means a rebuilt sandbox: pair afresh, not the saved host.
              void start('open', { freshPairing: signerChanged }).finally(() =>
                setWakeTappedAt(null)
              )
            }}
            style={({ pressed }) => [
              styles.primary,
              primaryDisabled && !busy && styles.primaryDisabled,
              pressed && styles.pressed
            ]}
          >
            {busy ? <ActivityIndicator size="small" color={colors.bgBase} /> : null}
            <Text
              style={[styles.primaryText, primaryDisabled && !busy && styles.primaryTextDisabled]}
            >
              {primaryLabel}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
