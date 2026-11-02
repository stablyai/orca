import { memo, useCallback, useState, type ReactNode } from 'react'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useBackClaim } from '../navigation/use-back-claim'
import { OptionPager, useOptionPager } from '../components/BottomDrawer'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { MobileGitHistoryItem } from './git-history-reply-schema'
import { MobileCommitDetailPage } from './MobileCommitDetailPage'
import type { MobileDiffFileTarget } from './use-mobile-source-control-openers'
import { MobileGitHistoryList, type MobileGitHistoryListProps } from './MobileGitHistoryList'

type OpenCommit = (commit: MobileGitHistoryItem) => void

type Props = Omit<MobileGitHistoryListProps, 'onOpenCommit'> & {
  // A docked panel owns its safe area; a full-screen pushed page pads under the status bar itself.
  embedded?: boolean
  // Set by a parent whose own commit page covers more than this list, e.g. the whole Source Control screen.
  onOpenCommit?: OpenCommit
  openDiffForFile?: (target: MobileDiffFileTarget) => void
}

// The branch's commits; a commit opens over them unless the parent hosts the commit page itself.
export const MobileCommitsScreen = memo(function MobileCommitsScreen({
  embedded = false,
  onOpenCommit,
  openDiffForFile,
  ...props
}: Props) {
  const list = (open: OpenCommit) => <MobileGitHistoryList {...props} onOpenCommit={open} />
  const body = onOpenCommit ? (
    list(onOpenCommit)
  ) : (
    // Remount per tree so another host's or worktree's open commit and pager slide never linger.
    <MobileCommitPageHost
      key={`${props.hostId}\0${props.worktreeId}`}
      client={props.client}
      connState={props.connState}
      worktreeId={props.worktreeId}
      bottomInset={props.bottomInset}
      padTop={false}
      openDiffForFile={openDiffForFile}
    >
      {list}
    </MobileCommitPageHost>
  )
  // Only the pushed page covers the panel header; in today's Commits tab the panel already pads.
  return props.onBack && !embedded ? (
    <SafeAreaView style={styles.fill} edges={['top']}>
      {body}
    </SafeAreaView>
  ) : (
    body
  )
})

// Pushes one commit's page over `children` with its own header, so it never sits under another one.
export function MobileCommitPageHost({
  client,
  connState,
  worktreeId,
  bottomInset,
  padTop,
  openDiffForFile,
  children
}: {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  bottomInset: number
  // The page covers a screen-top header, so it pads under the status bar unless an ancestor already did.
  padTop: boolean
  openDiffForFile?: (target: MobileDiffFileTarget) => void
  children: (openCommit: OpenCommit) => ReactNode
}) {
  const pager = useOptionPager<'commit'>()
  const { open, close } = pager
  const [commit, setCommit] = useState<MobileGitHistoryItem | null>(null)
  const commitOpen = pager.page === 'commit' && commit !== null
  // Back closes an open commit before it leaves the screen, like the workspace options pages.
  useBackClaim(
    commitOpen
      ? () => {
          close()
          return true
        }
      : null
  )
  const openCommit = useCallback(
    (next: MobileGitHistoryItem) => {
      setCommit(next)
      open('commit')
    },
    [open]
  )
  const page =
    commitOpen && commit ? (
      <MobileCommitDetailPage
        client={client}
        connState={connState}
        worktreeId={worktreeId}
        commit={commit}
        bottomInset={bottomInset}
        onBack={close}
        onOpenFile={
          openDiffForFile
            ? (filePath) => openDiffForFile({ kind: 'commit', filePath, commitOid: commit.id })
            : undefined
        }
      />
    ) : null
  return (
    <OptionPager
      fill
      pager={pager}
      main={children(openCommit)}
      page={
        page && padTop ? (
          <SafeAreaView style={styles.fill} edges={['top']}>
            {page}
          </SafeAreaView>
        ) : (
          page
        )
      }
    />
  )
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1, backgroundColor: colors.bgBase }
}))
