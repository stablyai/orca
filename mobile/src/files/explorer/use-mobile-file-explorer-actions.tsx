import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { FilePlus2, FolderPlus, Plus, Upload } from 'lucide-react-native'
import { FILE_MOBILE_EXPLORER_MUTATIONS_RUNTIME_CAPABILITY } from '../../../../src/shared/file-access/files-runtime-capabilities'
import { TransientToast, useTransientToast } from '../../components/feedback/TransientToast'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useOptionalRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import {
  preloadNameSheet,
  useMobileFileExplorerRowActions
} from './mobile-file-explorer-row-actions-sheet'
import {
  isPathOrDescendant,
  parentPathOf,
  type ExplorerTarget
} from './mobile-file-explorer-mutations'
import { useMobileFileExplorerUploads } from './use-mobile-file-explorer-uploads'

// The folder and every folder above it, so a row made inside it shows.
function withFolderOpen(expanded: Set<string>, folder: string): Set<string> {
  const segments = folder.split('/')
  const next = new Set(expanded)
  segments.forEach((_, index) => next.add(segments.slice(0, index + 1).join('/')))
  return next
}

// A renamed folder stays open under its new path; a deleted one (to null) is forgotten with its subfolders.
function withFolderMoved(expanded: Set<string>, from: string, to: string | null): Set<string> {
  if (![...expanded].some((path) => isPathOrDescendant(path, from))) {
    return expanded
  }
  return new Set(
    [...expanded].flatMap((path) =>
      !isPathOrDescendant(path, from) ? [path] : to === null ? [] : [to + path.slice(from.length)]
    )
  )
}

/** The explorer's writes: each row's long-press sheet, the root's Upload/New File/New Folder menu, uploads, and a toast. */
export function useMobileFileExplorerActions(args: {
  hostId: string
  client: RpcClient | null
  /** The panel's scope, which its rows read uploads under. */
  scope: string
  target: ExplorerTarget
  /** False for an older host's whole-tree listing, whose host predates the phone's file writes. */
  pagedListing: boolean
  /** Inside a panel that names it already (a bot's Files tab): no header, so no ⋯ menu. */
  headerless: boolean
  setExpanded: Dispatch<SetStateAction<Set<string>>>
  previewFile: (relativePath: string, name: string) => void
}) {
  const t = useMobileTranslation()
  const { setExpanded, previewFile } = args
  const canMutate =
    useOptionalRouteCapability(FILE_MOBILE_EXPLORER_MUTATIONS_RUNTIME_CAPABILITY) &&
    args.pagedListing
  const { message, showToast } = useTransientToast()
  const menuAnchor = useRef(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const { startUpload, clashSheet } = useMobileFileExplorerUploads({
    hostId: args.hostId,
    client: args.client,
    scope: args.scope,
    target: args.target,
    pagedListing: args.pagedListing,
    setExpanded,
    showToast
  })
  const upload = startUpload ? (parent: string) => void startUpload(parent) : null
  const { openRowActions, openCreate, openNewChoice, rowActionsSheet } =
    useMobileFileExplorerRowActions({
      hostId: args.hostId,
      client: args.client,
      target: args.target,
      canMutate,
      showToast,
      upload,
      onCreated: (relativePath, kind, shown) => {
        const parent = parentPathOf(relativePath)
        if (parent) {
          setExpanded((previous) => withFolderOpen(previous, parent))
        }
        // A new file opens, as desktop opens it in the editor, unless the user backed out of its sheet.
        if (kind === 'file' && shown) {
          previewFile(relativePath, relativePath.slice(parent ? parent.length + 1 : 0))
        }
      },
      onMoved: (from, to) => setExpanded((previous) => withFolderMoved(previous, from, to)),
      onRemoved: (relativePath) =>
        setExpanded((previous) => withFolderMoved(previous, relativePath, null))
    })

  const newLabel = t('files.fileExplorerPanel.newEntry', 'New')
  // iOS can't present the next sheet or the file picker while the menu's Modal is still up.
  const rootMenu = [
    ...(upload
      ? [
          {
            label: t('files.fileExplorerRowActions.uploadFiles', 'Upload Files'),
            icon: Upload,
            closeBeforePress: true,
            onPress: () => upload('')
          }
        ]
      : []),
    ...(openCreate
      ? [
          {
            label: t('files.fileExplorerRowActions.newFile', 'New File'),
            icon: FilePlus2,
            closeBeforePress: true,
            onPress: () => openCreate('file', '')
          },
          {
            label: t('files.fileExplorerRowActions.newFolder', 'New Folder'),
            icon: FolderPlus,
            closeBeforePress: true,
            onPress: () => openCreate('folder', '')
          }
        ]
      : [])
  ]
  return {
    openRowActions,
    // An empty workspace has no row to long-press, and a panel without a header has no ⋯ menu:
    // both offer New File / New Folder at the root as a sheet.
    newEntry: {
      stateAction: openNewChoice ? { label: newLabel, onPress: openNewChoice } : null,
      searchBarButton:
        openNewChoice && args.headerless
          ? { icon: Plus, accessibilityLabel: newLabel, onPress: openNewChoice }
          : undefined
    },
    rootMenuButton:
      rootMenu.length > 0 ? (
        <NavBarButton
          ref={menuAnchor}
          icon={Plus}
          accessibilityLabel={t('files.fileExplorerPanel.add', 'Add')}
          onPress={() => {
            void preloadNameSheet()
            setMenuOpen(true)
          }}
        />
      ) : undefined,
    overlays: (toastBottomInset: number) => (
      <>
        {rootMenu.length > 0 ? (
          <PullDownMenu
            visible={menuOpen}
            anchorRef={menuAnchor}
            onClose={() => setMenuOpen(false)}
            groups={[rootMenu]}
          />
        ) : null}
        {rowActionsSheet}
        {clashSheet}
        <TransientToast message={message} bottomInset={toastBottomInset} />
      </>
    )
  }
}
