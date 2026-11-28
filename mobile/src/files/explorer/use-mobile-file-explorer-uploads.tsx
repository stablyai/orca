import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { CopyPlus, X } from 'lucide-react-native'
import { useQueryClient } from '@tanstack/react-query'
import { STAGED_FILE_UPLOAD_RUNTIME_CAPABILITY } from '../../../../src/shared/file-write/staged-file-save'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { ActionSheetContent } from '../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { triggerError, triggerSuccess } from '../../platform/haptics/haptics'
import { useMediaPicker } from '../../platform/media-picking/media-picker'
import {
  MOBILE_PICKED_FILE_MAX_BYTES,
  MobileFileTooLargeError,
  MobilePickedFilesBusyError
} from '../../platform/media-picking/media-picker-contract'
import { hostQueryKey } from '../../query/host-query-key'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useOptionalRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import { useWorkspaceClient } from '../../worktree/execution-hosts/use-workspace-client'
import { fileDirectoryQuery } from './mobile-file-explorer-operations'
import type { ExplorerTarget } from './mobile-file-explorer-mutations'
import { BRIDGE_MEDIA_MAX_LIVE_HANDLES } from '../../mobile-web-shell/bridge/native-capabilities/bridge-media-verbs'
import {
  enqueueUploads,
  noteUploadHostReachable,
  resolveClash,
  setClashPromptClosed,
  useUploadRows
} from './mobile-file-explorer-upload-queue'

function folderName(parent: string, t: ReturnType<typeof useMobileTranslation>): string {
  return parent
    ? parent.slice(parent.lastIndexOf('/') + 1)
    : t('files.fileExplorerUpload.workspaceRoot', 'the workspace root')
}

/** Upload into a folder: the picker, the rows that show each file going in, and the sheet a taken name asks from. */
export function useMobileFileExplorerUploads(args: {
  hostId: string
  client: RpcClient | null
  /** The panel's scope, which its rows read uploads under. */
  scope: string
  target: ExplorerTarget
  /** False for an older host's whole-tree listing, whose host predates phone uploads. */
  pagedListing: boolean
  setExpanded: Dispatch<SetStateAction<Set<string>>>
  showToast: (message: string) => void
}) {
  const t = useMobileTranslation()
  const { hostId, client, target, scope, setExpanded, showToast } = args
  const queryClient = useQueryClient()
  const picker = useMediaPicker()
  const hostTakesUploads = useOptionalRouteCapability(STAGED_FILE_UPLOAD_RUNTIME_CAPABILITY)
  const pickStagedFiles = picker.pickStagedFiles
  const uploads = useUploadRows(scope)
  const hasUploads = uploads.length > 0
  // Only what the client can't see itself: a relayed server down while the paired computer is up.
  // The route's state: for a relayed server, the server's own reach, not the paired computer's.
  const routeState = useWorkspaceClient(hostId).state
  const routeDown = routeState !== 'connected' && client?.getState() === 'connected'
  useEffect(() => {
    if (hasUploads) {
      noteUploadHostReachable(scope, !routeDown)
    }
  }, [hasUploads, routeDown, scope])

  const startUpload =
    client && pickStagedFiles && hostTakesUploads && args.pagedListing
      ? async (parent: string) => {
          let files
          try {
            files = await pickStagedFiles()
          } catch (error) {
            triggerError()
            showToast(
              error instanceof MobileFileTooLargeError
                ? t(
                    'files.fileExplorerUpload.tooLarge',
                    "Files over {{max}} MB can't be uploaded from the phone yet.",
                    { max: Math.floor(MOBILE_PICKED_FILE_MAX_BYTES / (1024 * 1024)) }
                  )
                : error instanceof MobilePickedFilesBusyError
                  ? t(
                      'files.fileExplorerUpload.busy',
                      'You can upload up to {{max}} files at a time.',
                      { max: BRIDGE_MEDIA_MAX_LIVE_HANDLES }
                    )
                  : t(
                      'files.fileExplorerUpload.pickFailed',
                      "Couldn't open your files. {{reason}}",
                      {
                        reason: error instanceof Error ? error.message : ''
                      }
                    ).trim()
            )
            return
          }
          if (files.length === 0) {
            return
          }
          // The folder and those above it, so its upload rows show even when picked from search results.
          if (parent) {
            const segments = parent.split('/')
            setExpanded((previous) => {
              const next = new Set(previous)
              segments.forEach((_, index) => next.add(segments.slice(0, index + 1).join('/')))
              return next
            })
          }
          enqueueUploads({
            scope,
            client,
            target,
            parent,
            files,
            refreshFolder: () =>
              void queryClient.invalidateQueries({
                queryKey: hostQueryKey(hostId, fileDirectoryQuery.family, target, {
                  relativePath: parent
                }),
                exact: true
              }),
            onDone: ({ uploaded, lost, folder }) => {
              if (lost > 0) {
                triggerError()
                showToast(
                  t(
                    'files.fileExplorerUpload.lost',
                    "{{count}} files weren't uploaded: the phone let go of them. Pick them again.",
                    { count: lost }
                  )
                )
                return
              }
              triggerSuccess()
              showToast(
                t('files.fileExplorerUpload.uploaded', 'Uploaded {{count}} files to {{folder}}', {
                  count: uploaded,
                  folder: folderName(folder, t)
                })
              )
            }
          })
        }
      : null

  const clash = uploads.find((upload) => upload.status === 'clash' && !upload.promptClosed)
  const clashes = clash
    ? uploads.filter((upload) => upload.status === 'clash' && upload.batch === clash.batch)
    : []
  const several = clashes.length > 1
  const folder = clash ? folderName(clash.parent, t) : ''
  const closeClash = () =>
    setClashPromptClosed(
      clashes.map(({ id }) => id),
      true
    )

  return {
    startUpload,
    clashSheet: (
      <BottomDrawer visible={clash !== undefined} onClose={closeClash}>
        {clash ? (
          <ActionSheetContent
            title={
              several
                ? t(
                    'files.fileExplorerUpload.clashTitleSeveral',
                    '{{count}} files are already in {{folder}}',
                    { count: clashes.length, folder }
                  )
                : clash.name
            }
            message={
              several
                ? undefined
                : t('files.fileExplorerUpload.clashMessage', 'Already in {{folder}}', { folder })
            }
            onClose={closeClash}
            actions={[
              {
                id: 'keepBoth',
                label: t('files.fileExplorerUpload.keepBoth', 'Keep Both'),
                icon: CopyPlus,
                hint:
                  !several && clash.copyName
                    ? t('files.fileExplorerUpload.keepBothAs', 'Saves as {{name}}', {
                        name: clash.copyName
                      })
                    : t('files.fileExplorerUpload.keepBothCopies', 'Saves each as a copy'),
                onPress: () => resolveClash(clash.id, 'keepBoth', several)
              },
              {
                id: 'skip',
                label: several
                  ? t('files.fileExplorerUpload.skipAll', 'Skip All')
                  : t('files.fileExplorerUpload.skip', 'Skip'),
                icon: X,
                onPress: () => resolveClash(clash.id, 'skip', several)
              }
            ]}
          />
        ) : null}
      </BottomDrawer>
    )
  }
}
