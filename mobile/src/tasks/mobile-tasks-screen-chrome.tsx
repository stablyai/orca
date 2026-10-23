import type { PageChromeModel } from './use-mobile-tasks-page-chrome'
import {
  View,
  Text,
  ActivityIndicator,
  StatusDot,
  RefreshCw,
  Plus,
  colors
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { renderMobileTasksProviderControls } from './mobile-tasks-provider-controls'
import { renderMobileTasksSearchControl } from './mobile-tasks-search-control'
import { selectMobileTasksProvider } from './mobile-tasks-provider-pickers'
import { IconButton } from '../components/ui/IconButton'
import { Banner } from '../components/ui/Banner'
import { LargeTitle, NavBar } from '../components/ui/NavBar'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'

// Same wording as the desktop task page's icon buttons.
const REFRESH_LABELS = {
  github: 'Refresh GitHub work',
  gitlab: 'Refresh GitLab work items',
  linear: 'Refresh Linear',
  jira: 'Refresh Jira issues'
} as const

/**
 * Everything above the rows: the large title, the source switch, search, the scope chips and any
 * notices. It scrolls with the list so the title can collapse into the bar.
 */
export function renderMobileTasksChrome(model: PageChromeModel) {
  const {
    connState,
    githubMode,
    githubProjectLoading,
    githubProjectTable,
    headerVerdict,
    hostTitle,
    provider,
    providerOptions,
    refreshing,
    taskUiReady
  } = model
  const away = connState !== 'connected'
  const subtitle = [hostTitle, away ? headerVerdict.label : null].filter(Boolean).join(' · ')
  const showRefreshing =
    refreshing ||
    (provider === 'github' &&
      githubMode === 'project' &&
      githubProjectLoading &&
      githubProjectTable !== null)
  return (
    <View style={styles.pageHeader}>
      <LargeTitle
        title="Tasks"
        subtitle={
          <View style={styles.largeTitleSubtitle}>
            <StatusDot state={connState} verdict={headerVerdict} />
            <Text style={styles.largeTitleSubtitleText} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        }
      />

      {providerOptions.length > 1 ? (
        <MobileSegmentedControl
          segments={providerOptions.map((option) => ({
            value: option.value,
            label: option.label
          }))}
          selected={provider}
          onSelect={(next) => {
            if (next !== provider) {
              selectMobileTasksProvider(model, next)
            }
          }}
          disabled={!taskUiReady}
          fill
          testIDPrefix="mobile-tasks-provider-"
          style={styles.providerSwitch}
        />
      ) : null}

      {renderMobileTasksSearchControl(model)}

      {renderMobileTasksProviderControls(model)}

      {renderMobileTasksNotices(model)}

      {showRefreshing ? (
        <View style={styles.refreshingRow} accessibilityRole="progressbar">
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.refreshingText}>Refreshing…</Text>
        </View>
      ) : null}
    </View>
  )
}

/** The page's failures and source notices, as banners above the rows. */
function renderMobileTasksNotices(model: PageChromeModel) {
  const {
    error,
    githubMode,
    githubProjectTable,
    githubSourceErrors,
    githubSourceFallbacks,
    loading,
    provider,
    retryGitHubIssueSourceFetch,
    retryingGithubSourceRepoPaths,
    setError
  } = model
  const githubItems = provider === 'github' && githubMode === 'items'
  const notices = [
    error ? (
      <Banner key="error" tone="error" message={error} onDismiss={() => setError('')} />
    ) : null,
    ...(!error && githubItems
      ? githubSourceFallbacks.map((fallback) => (
          <Banner
            key={`github-source-fallback:${fallback.repoId}`}
            tone="warning"
            message={`Upstream issues aren't available for ${fallback.repoLabel}, so Tasks shows origin's.`}
          />
        ))
      : []),
    ...(!error && githubItems
      ? githubSourceErrors.map((sourceError) => {
          const slug = `${sourceError.source.owner}/${sourceError.source.repo}`
          return (
            <Banner
              key={`github-source-error:${sourceError.repoId}:${slug}`}
              tone="warning"
              title={`Couldn't load issues from ${slug}.`}
              message={sourceError.message}
              action={{
                label: 'Try again',
                busy: retryingGithubSourceRepoPaths.has(sourceError.repoPath),
                onPress: () => {
                  if (!loading) {
                    void retryGitHubIssueSourceFetch(sourceError.repoPath)
                  }
                }
              }}
            />
          )
        })
      : []),
    !error &&
    provider === 'github' &&
    githubMode === 'project' &&
    githubProjectTable?.parentFieldDropped === true ? (
      <Banner
        key="project-parent"
        tone="warning"
        message="Your GitHub token can't read sub-issues, so parent issues aren't shown."
      />
    ) : null
  ].filter((notice) => notice !== null)
  return notices.length > 0 ? <View style={styles.bannerStack}>{notices}</View> : null
}

/** Back, the collapsed title, Refresh and New. */
export function renderMobileTasksStatusBar(model: PageChromeModel) {
  const {
    githubMode,
    githubProjectLoading,
    hostTitle,
    linearConnected,
    loading,
    pageScrolled,
    pageTitleCollapsed,
    provider,
    refreshGitHubProject,
    refreshTasks,
    refreshing,
    router,
    setCreateBody,
    setCreateTitle,
    setLinearApiKeyDraft,
    setLinearConnectError,
    setLinearConnectState,
    setShowCreateTask,
    setShowLinearConnect,
    showHeaderCreateTask,
    taskUiReady
  } = model
  return (
    <NavBar
      title="Tasks"
      subtitle={hostTitle ?? undefined}
      onBack={() => router.back()}
      titleVisible={pageTitleCollapsed}
      scrolled={pageScrolled}
      trailing={
        <>
          <IconButton
            icon={RefreshCw}
            iconSize={18}
            accessibilityLabel={REFRESH_LABELS[provider]}
            disabled={!taskUiReady || loading || refreshing || githubProjectLoading}
            onPress={() => {
              if (!taskUiReady) {
                return
              }
              if (provider === 'github' && githubMode === 'project') {
                refreshGitHubProject()
                return
              }
              refreshTasks()
            }}
          />
          {/* A disconnected Linear shows Connect as the page's own action, so the bar skips it. */}
          {showHeaderCreateTask && (provider !== 'linear' || linearConnected) ? (
            <IconButton
              icon={Plus}
              variant="primary"
              accessibilityLabel={
                provider === 'github'
                  ? 'New GitHub issue'
                  : linearConnected
                    ? 'New Linear issue'
                    : 'Connect Linear'
              }
              disabled={!taskUiReady}
              onPress={() => {
                if (!taskUiReady) {
                  return
                }
                if (provider === 'linear' && !linearConnected) {
                  setLinearApiKeyDraft('')
                  setLinearConnectState('idle')
                  setLinearConnectError('')
                  setShowLinearConnect(true)
                  return
                }
                setCreateTitle('')
                setCreateBody('')
                setShowCreateTask(true)
              }}
            />
          ) : null}
        </>
      }
    />
  )
}
