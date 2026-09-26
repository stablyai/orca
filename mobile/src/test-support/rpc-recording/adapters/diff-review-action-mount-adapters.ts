import { hookMount, performHookAction } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import type { DiffComment } from '../../../../../src/shared/diff-comment-types'
import type { MobileDiffReviewQueueItem } from '../../../session/mobile-diff-review-queue'
import type {
  ReviewScreenState,
  SendSheetState
} from '../../../session/mobile-diff-review-screen-model'
import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKSPACE = 'workspace-1'
const HOST = 'host-1'
const FILE = 'src/app.ts'
const TERMINAL = 'terminal-1'

/**
 * Everything the review screen writes: the note/review-state metadata save, the stage/unstage/
 * discard mutations, the reveal-in-session open, and the two ways review notes reach a terminal.
 *
 * One mount, because the screen composes the comment, git and send hooks into a single interaction
 * surface and they share the client and the error setter. The send arm also drives the stale-input
 * heal, whose clearing write only happens when a prior image paste marked the handle — so the
 * marker is set by an action rather than assumed.
 */
export function diffReviewActionMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.diff-review-actions': ({ client, effect }) => {
      const useInteractions = modules.load<
        typeof import('../../../session/use-mobile-diff-review-interactions')
      >('mobile/src/session/use-mobile-diff-review-interactions.ts').useMobileDiffReviewInteractions
      const staleInput = modules.load<
        typeof import('../../../session/mobile-native-chat-stale-input')
      >('mobile/src/session/mobile-native-chat-stale-input.ts')
      staleInput.resetMobileNativeChatStaleInputForTests()
      const comment: DiffComment = {
        side: 'modified',
        id: 'note-1',
        worktreeId: WORKSPACE,
        filePath: FILE,
        lineNumber: 4,
        body: 'needs a test',
        createdAt: 0
      }
      const item: MobileDiffReviewQueueItem = {
        key: `unstaged:${FILE}`,
        scope: 'unstaged' as const,
        area: 'unstaged' as const,
        filePath: FILE,
        status: 'modified' as const,
        title: 'app.ts',
        subtitle: 'src',
        canStage: true,
        canUnstage: false,
        canDiscard: true,
        isGeneratedOrLockFile: false,
        diffIdentity: 'identity-1',
        noteCount: 1,
        unsentNoteCount: 1,
        staleNoteCount: 0,
        isReviewed: true,
        changedSinceReview: false
      }
      let screenState: ReviewScreenState = {
        kind: 'ready',
        // These actions never read the status; the queue item above is what they branch on.
        status: mountFixture<Extract<ReviewScreenState, { kind: 'ready' }>['status']>({
          entries: []
        }),
        branchCompare: null,
        comments: [comment],
        reviewState: { version: 1, files: {} }
      }
      let actionError: string | null = null
      let busyAction: string | null = null
      let sendSheet: SendSheetState | null = null
      let interactions: ReturnType<typeof useInteractions>
      const hook = hookMount(() => {
        interactions = useInteractions(
          mountFixture<Parameters<typeof useInteractions>[0]>({
            client,
            connState: 'connected',
            hostCapabilities: [
              'agent.launch.v2',
              'agent.launch.replay.v1',
              'agent.launch.replay-required.v1'
            ],
            hostId: HOST,
            worktreeId: WORKSPACE,
            screenState,
            diffState: { kind: 'idle' },
            currentItem: item,
            queue: [item],
            filteredQueue: [item],
            filter: 'all',
            currentIndex: 0,
            activeHunkIndex: null,
            composer: null,
            composerBody: '',
            listRef: { current: null },
            setScreenState: (update) => {
              screenState = typeof update === 'function' ? update(screenState) : update
            },
            setFilter: () => {},
            setCurrentIndex: () => {},
            setActiveHunkIndex: () => {},
            setComposer: () => {},
            setComposerBody: () => {},
            setActionError: (update) => {
              actionError = typeof update === 'function' ? update(actionError) : update
            },
            setBusyAction: (update) => {
              busyAction = typeof update === 'function' ? update(busyAction) : update
            },
            setSendSheet: (update) => {
              sendSheet = typeof update === 'function' ? update(sendSheet) : update
            },
            setShowCompletion: () => {},
            loadReviewData: () => {
              effect('load-review-data', {})
              return Promise.resolve()
            },
            onOpenSession: () => effect('open-session', {}),
            onReconnect: (hostId: string) => effect('reconnect', { hostId })
          })
        )
      })
      hook.mount()
      return {
        action(name, args) {
          if (name === 'mark-stale') {
            staleInput.markMobileNativeChatInputStale(TERMINAL)
            return TERMINAL
          }
          return performHookAction(() => {
            if (name === 'mark-reviewed') {
              return interactions.markReviewed()
            }
            if (name === 'stage') {
              return interactions.runGitMutation('git.stage', item)
            }
            if (name === 'discard') {
              return interactions.runGitMutation('git.discard', item)
            }
            if (name === 'stage-reviewed') {
              return interactions.stageReviewedFiles()
            }
            if (name === 'open-send-sheet') {
              return interactions.openSendSheet()
            }
            if (name === 'open-in-session') {
              return interactions.openInSession()
            }
            if (name === 'send-notes') {
              return interactions.sendPromptToTerminal(TERMINAL, [comment])
            }
            if (name === 'create-and-send') {
              return interactions.createTerminalAndSend([comment])
            }
            if (name === 'copy-notes') {
              return interactions.copyNotes()
            }
            if (name === 'clear-sent') {
              return interactions.clearSentNotes()
            }
            throw new Error(`Unknown review action: ${name}${String(args.unused ?? '')}`)
          })
        },
        state: () => ({ screenState, actionError, busyAction, sendSheet }),
        dispose: () => {
          staleInput.resetMobileNativeChatStaleInputForTests()
          hook.unmount()
        }
      }
    }
  }
}
