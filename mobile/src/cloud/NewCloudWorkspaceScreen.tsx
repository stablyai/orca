import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { structuredSessionOperationId } from '../session/structured-session-operation-id'
import { SettingsNavBar, SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { ORCA_CLOUD_DEFAULT_AGENT } from '../../../src/shared/hosted-sandbox/orca-cloud-image-agents'
import { CloudAgentPicker } from './CloudAgentPicker'
import { CloudPhaseSteps } from './CloudPhaseSteps'
import { createCloudWorkspace, renameCloudWorkspace } from './cloud-control-plane-client'
import { enqueueCloudPrompt } from './cloud-prompt-queue'
import { loadCloudDeviceIdentity } from './cloud-device-identity'
import { CloudElapsed } from './CloudElapsed'
import {
  forgetRevokedCloudSession,
  loadCloudControlPlane,
  useCloudHostRemoval
} from './cloud-session'
import { recordCloudWorkspaceProjectRoot } from './cloud-workspace-links'
import { cloudScrollBottomPadding } from './cloud-workspace-screen-styles'
import { cloudWorkspaceIdFor, normalizeCloudRepoInput } from './cloud-repo-input'
import {
  useCloudEnrollment,
  useCloudWorkspaces,
  useInvalidateCloudWorkspaces,
  useSeedCloudWorkspace
} from './use-cloud-workspaces'
import { nextCloudWorkspaceTitle } from './cloud-workspace-display'
import { roleForCloudError } from './cloud-entitlement-copy'
import { createErrorMessage } from './cloud-workspace-copy'

type Size = 'standard' | 'large'

export function NewCloudWorkspaceScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const invalidate = useInvalidateCloudWorkspaces()
  const existing = useCloudWorkspaces(useCloudEnrollment()).data
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [agent, setAgent] = useState(ORCA_CLOUD_DEFAULT_AGENT)
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState<Size>('standard')
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const removal = useCloudHostRemoval()
  const seed = useSeedCloudWorkspace()
  const mountedRef = useRef(true)
  const creatingRef = useRef(false)
  // One id per form: a retry after a lost reply reuses it, and the server answers with the same sandbox.
  const workspaceIdRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const repoUrl = repo.trim() ? normalizeCloudRepoInput(repo) : null
  // A different repo or branch is a different workspace, so it gets its own id.
  useEffect(() => {
    workspaceIdRef.current = null
  }, [repoUrl, branch, size])
  const repoInvalid = repo.trim() !== '' && repoUrl === null
  const creating = startedAt !== null

  const create = async () => {
    if (creatingRef.current || repoInvalid) {
      return
    }
    creatingRef.current = true
    const plane = await loadCloudControlPlane()
    const enrollment = (await loadCloudDeviceIdentity()).enrollment
    if (!plane || !enrollment) {
      creatingRef.current = false
      router.replace('/')
      return
    }
    setError(null)
    setStartedAt(Date.now())
    const controller = new AbortController()
    abortRef.current = controller
    let created: Awaited<ReturnType<typeof createCloudWorkspace>>
    try {
      created = await createCloudWorkspace(
        plane,
        {
          workspaceId: (workspaceIdRef.current ??= cloudWorkspaceIdFor(repoUrl)),
          machineSize: size,
          ...(repoUrl
            ? { repo: { url: repoUrl, ...(branch.trim() ? { ref: branch.trim() } : {}) } }
            : {})
        },
        controller.signal
      )
    } catch (failure) {
      if (controller.signal.aborted || !mountedRef.current) {
        creatingRef.current = false
        return
      }
      await forgetRevokedCloudSession(failure, removal)
      const role = await roleForCloudError(failure, plane)
      creatingRef.current = false
      if (!mountedRef.current) {
        return
      }
      setStartedAt(null)
      setError(createErrorMessage(failure, t, role))
      return
    }
    // The sandbox exists from here on: nothing below may report "couldn't create" or create again.
    const { projectRoot } = created
    const workspace = {
      ...created.workspace,
      title: nextCloudWorkspaceTitle(created.workspace.title, existing ?? [])
    }
    await recordCloudWorkspaceProjectRoot(workspace.id, projectRoot).catch(() => undefined)
    void renameCloudWorkspace(plane, workspace.id, workspace.title)
    if (prompt.trim()) {
      await enqueueCloudPrompt({
        sandboxId: workspace.id,
        text: prompt.trim(),
        agent,
        operationId: structuredSessionOperationId()
      }).catch(() => undefined)
    }
    seed(enrollment.deviceSessionId, workspace)
    invalidate()
    if (mountedRef.current) {
      router.replace({
        pathname: '/cloud/[sandboxId]',
        params: { sandboxId: workspace.id, autostart: '1' }
      })
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <SettingsNavBar
          title={t('cloud.new.title', 'Create workspace')}
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
          <SettingsSection
            first
            title={t('cloud.new.repoHeading', 'Repository')}
            footer={
              repoInvalid ? (
                <SettingsNote error>
                  {t('cloud.new.repoInvalid', 'Use a GitHub repository, like owner/repo.')}
                </SettingsNote>
              ) : (
                t(
                  'cloud.new.repoNote',
                  'Private repos need the Orca Cloud GitHub app, connected once from Orca on your computer. Leave empty for a blank project.'
                )
              )
            }
          >
            <View key="repo" style={styles.field}>
              <TextInput
                style={styles.input}
                value={repo}
                onChangeText={setRepo}
                editable={!creating}
                placeholder={t('cloud.new.repoPlaceholder', 'owner/repo')}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                accessibilityLabel={t('cloud.new.repoLabel', 'GitHub repository')}
              />
            </View>
          </SettingsSection>
          <SettingsSection title={t('cloud.new.branchLabel', 'Branch')}>
            <View key="branch" style={styles.field}>
              <TextInput
                style={styles.input}
                value={branch}
                onChangeText={setBranch}
                editable={!creating}
                placeholder={t('cloud.new.branchPlaceholder', 'Default branch')}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t('cloud.new.branchLabel', 'Branch')}
              />
            </View>
          </SettingsSection>

          <SettingsSection title={t('cloud.new.agentHeading', 'First task')}>
            <View key="task" style={styles.field}>
              <CloudAgentPicker value={agent} onChange={setAgent} disabled={creating} />
              <TextInput
                style={[styles.input, styles.multiline]}
                value={prompt}
                onChangeText={setPrompt}
                editable={!creating}
                multiline
                placeholder={t(
                  'cloud.new.promptPlaceholder',
                  'Optional. What should the agent start on?'
                )}
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={t('cloud.prompt.label', 'Prompt')}
                maxLength={20_000}
              />
            </View>
          </SettingsSection>

          <SettingsSection title={t('cloud.new.sizeHeading', 'Sandbox size')} radioGroup>
            <View key="size" style={styles.segmented}>
              {(['standard', 'large'] as const).map((option) => (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: size === option, disabled: creating }}
                  disabled={creating}
                  onPress={() => setSize(option)}
                  style={[styles.segment, size === option && styles.segmentSelected]}
                >
                  <Text
                    style={[styles.segmentTitle, size === option && styles.segmentTitleSelected]}
                  >
                    {option === 'standard'
                      ? t('cloud.size.standardShort', 'Standard')
                      : t('cloud.size.largeShort', 'Large')}
                  </Text>
                  <Text style={styles.segmentDetail}>
                    {option === 'standard'
                      ? t('cloud.size.standardSpec', '4 vCPU · 8 GB')
                      : t('cloud.size.largeSpec', '8 vCPU · 16 GB')}
                  </Text>
                </Pressable>
              ))}
            </View>
          </SettingsSection>
          <Text style={styles.sizeNote}>
            {t('cloud.size.largeNote', 'Large uses sandbox hours at 2× the rate.')}
          </Text>

          {creating ? (
            <View style={styles.progress}>
              <CloudPhaseSteps
                phase="creating"
                creating
                delivering={prompt.trim() !== ''}
                since={startedAt}
              />
            </View>
          ) : null}
          {error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
        </ScrollView>

        <View style={[styles.actionBar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: creating || repoInvalid, busy: creating }}
            disabled={creating || repoInvalid}
            onPress={() => void create()}
            style={({ pressed }) => [
              styles.primary,
              repoInvalid && styles.primaryDisabled,
              pressed && styles.pressed
            ]}
          >
            {creating ? <ActivityIndicator size="small" color={colors.bgBase} /> : null}
            <Text style={styles.primaryText}>
              {creating
                ? t('cloud.new.creating', 'Starting your cloud workspace')
                : prompt.trim()
                  ? t('cloud.new.createAndStart', 'Start workspace and agent')
                  : t('cloud.new.create', 'Start workspace')}
            </Text>
            {startedAt !== null ? (
              <CloudElapsed since={startedAt} style={styles.primaryElapsed} />
            ) : null}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase },
  flex: { flex: 1 },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  field: { padding: spacing.md, gap: spacing.md },
  input: {
    minHeight: 44,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.control,
    paddingHorizontal: spacing.md,
    paddingVertical: 10
  },
  multiline: { minHeight: 96, maxHeight: 200, textAlignVertical: 'top', lineHeight: 21 },
  segmented: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md },
  segment: {
    flex: 1,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    gap: 2
  },
  segmentSelected: { borderColor: colors.textPrimary },
  segmentTitle: { fontSize: 15, color: colors.textSecondary, fontWeight: '500' },
  segmentTitleSelected: { color: colors.textPrimary, fontWeight: '600' },
  sizeNote: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
    marginTop: 6,
    paddingHorizontal: spacing.lg
  },
  segmentDetail: { fontSize: 13, color: colors.textMuted },
  progress: {
    marginTop: spacing.lg,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.surface,
    padding: spacing.lg
  },
  error: {
    marginTop: spacing.lg,
    fontSize: typography.bodySize,
    lineHeight: 20,
    color: colors.statusRed,
    paddingHorizontal: spacing.xs
  },
  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.bgBase,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  primary: {
    minHeight: 50,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  primaryDisabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  primaryText: { fontSize: 16, fontWeight: '600', color: colors.bgBase },
  primaryElapsed: {
    fontSize: 15,
    color: colors.bgBase,
    opacity: 0.7,
    fontVariant: ['tabular-nums']
  }
}))
