import { lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Copy,
  CopyPlus,
  Edit3,
  FilePlus2,
  FolderPlus,
  Share,
  Trash2,
  Upload
} from 'lucide-react-native'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import {
  ActionSheetContent,
  type ActionSheetAction
} from '../../components/sheets/ActionSheetModal'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { triggerError, triggerSuccess } from '../../platform/haptics/haptics'
import { useHostMutation, type HostMutationCallOptions } from '../../query/host-mutation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { TreeNode } from './file-tree'
import {
  duplicateExplorerFile,
  explorerCopy,
  explorerCreate,
  explorerDelete,
  explorerRename,
  type ExplorerTarget
} from './mobile-file-explorer-mutations'
import { useMobileFileExplorerShare } from './use-mobile-file-explorer-share'

type CreateKind = 'file' | 'folder'

// The name field's sheet loads on first use: its text field and header would otherwise ride along with every page that shows Files.
// Started when a menu opens, so the sheet is ready by the time Rename or New is tapped; the import resolves once.
export const preloadNameSheet = () => import('./mobile-file-explorer-name-sheet')
const NameSheet = lazy(() => preloadNameSheet().then(({ NameSheet }) => ({ default: NameSheet })))

export type SheetView =
  | { kind: 'menu'; node: TreeNode }
  | { kind: 'new' }
  | { kind: 'create'; parent: string; type: CreateKind }
  | { kind: 'rename'; node: TreeNode }
  | { kind: 'delete'; node: TreeNode }

/**
 * Pins one write to the workspace it was sent for: its lost-reply recovery is refused once another
 * workspace is shown (it would run on that one's host), and its follow-ups (folder state, toasts) are dropped.
 */
export type WritePin = {
  route: NonNullable<HostMutationCallOptions['route']>
  current: () => boolean
}

export type ExplorerWrites = {
  hostId: string
  client: RpcClient | null
  target: ExplorerTarget
  /** The host takes these writes from a phone; older hosts get the copy actions only. */
  canMutate: boolean
  /** `shown`: its sheet is still up, so the user still waits on it (a new file then opens). */
  onCreated: (relativePath: string, kind: CreateKind, shown: boolean) => void
  onMoved: (from: string, to: string) => void
  onRemoved: (relativePath: string) => void
  showToast: (message: string) => void
  /** Null where the host or the phone can't take uploads. */
  upload: ((parent: string) => void) | null
}

/** Which row's actions are open, the root's New File/New Folder, and the one drawer that shows them. */
export function useMobileFileExplorerRowActions(writes: ExplorerWrites) {
  const t = useMobileTranslation()
  const { hostId, client, target, canMutate, onRemoved, showToast } = writes
  // Held with the workspace it was opened for, so a sheet never writes into the next workspace shown.
  const scope = JSON.stringify([hostId, target])
  const [opened, setOpened] = useState<{ scope: string; view: SheetView } | null>(null)
  const view = opened?.scope === scope ? opened.view : null
  const sharing = useMobileFileExplorerShare(scope, target.worktree, showToast)
  const shownScope = useRef(scope)
  useLayoutEffect(() => {
    shownScope.current = scope
  }, [scope])
  const pin = (): WritePin => {
    const sent = scope
    const current = () => shownScope.current === sent
    return { route: (client) => (current() ? client : null), current }
  }
  const close = () => {
    sharing?.cancel()
    setOpened(null)
  }
  // Another action from the menu abandons a Share still downloading, so it can't close the newer sheet.
  const open = (next: SheetView) => {
    sharing?.cancel()
    setOpened({ scope, view: next })
  }
  const host = { hostId, client }
  // Every write lives as long as the explorer, so a lost reply is still settled after its sheet closes.
  const copy = useHostMutation(explorerCopy, host)
  const remove = useHostMutation(explorerDelete, host)
  const create = useHostMutation(explorerCreate, host)
  const rename = useHostMutation(explorerRename, host)

  const duplicate = (node: TreeNode) => {
    close()
    if (!client) {
      return
    }
    const written = pin()
    const send = (vars: Parameters<typeof copy.mutate>[0]) =>
      copy.mutate(vars, { route: written.route })
    void duplicateExplorerFile(client, send, target, node).then(
      () => {
        if (written.current()) {
          triggerSuccess()
        }
      },
      (error: unknown) => {
        if (!written.current()) {
          return
        }
        triggerError()
        showToast(
          t(
            'files.fileExplorerRowActions.duplicateFailed',
            "Couldn't duplicate {{name}}. {{reason}}",
            {
              name: node.name,
              reason: error instanceof Error ? error.message : ''
            }
          ).trim()
        )
      }
    )
  }

  const deleteNode = (node: TreeNode) => {
    close()
    const isDirectory = node.kind === 'directory'
    const written = pin()
    void remove
      .mutate({ target, relativePath: node.relativePath, isDirectory }, { route: written.route })
      .then(
        () => {
          if (written.current()) {
            triggerSuccess()
            onRemoved(node.relativePath)
          }
        },
        (error: unknown) => {
          if (!written.current()) {
            return
          }
          triggerError()
          showToast(
            t('files.fileExplorerRowActions.deleteFailed', "Couldn't delete {{name}}. {{reason}}", {
              name: node.name,
              reason: error instanceof Error ? error.message : ''
            }).trim()
          )
        }
      )
  }

  const rootUpload = (upload: (parent: string) => void): ActionSheetAction => ({
    id: 'upload',
    label: t('files.fileExplorerRowActions.uploadFiles', 'Upload Files'),
    icon: Upload,
    onPress: () => {
      close()
      upload('')
    }
  })
  let content: ReactNode = null
  if (view?.kind === 'menu') {
    content = (
      <RowActionsMenu
        node={view.node}
        canMutate={canMutate}
        blockedOffline={copy.blockedOffline}
        share={
          sharing && view.node.kind !== 'directory'
            ? {
                loading: sharing.sharing === view.node.relativePath,
                onPress: () => sharing.share(view.node, () => setOpened(null))
              }
            : null
        }
        onOpen={open}
        onDuplicate={duplicate}
        onUpload={writes.upload}
        onClose={close}
      />
    )
  } else if (view?.kind === 'create' || view?.kind === 'rename') {
    content = (
      <Suspense fallback={null}>
        <NameSheet
          view={view}
          writes={writes}
          create={create}
          rename={rename}
          pin={pin}
          onClose={close}
        />
      </Suspense>
    )
  } else if (view?.kind === 'new') {
    // The Files tab inside a panel has no header for the ⋯ menu, so its + opens these here.
    content = (
      <ActionSheetContent
        actions={[
          ...(writes.upload ? [rootUpload(writes.upload)] : []),
          ...(canMutate
            ? [
                {
                  id: 'newFile',
                  label: t('files.fileExplorerRowActions.newFile', 'New File'),
                  icon: FilePlus2,
                  onPress: () => open({ kind: 'create', parent: '', type: 'file' })
                },
                {
                  id: 'newFolder',
                  label: t('files.fileExplorerRowActions.newFolder', 'New Folder'),
                  icon: FolderPlus,
                  onPress: () => open({ kind: 'create', parent: '', type: 'folder' })
                }
              ]
            : [])
        ]}
      />
    )
  } else if (view?.kind === 'delete') {
    const { node } = view
    content = (
      <ConfirmContent
        title={t('files.fileExplorerRowActions.deleteTitle', 'Delete {{name}}?', {
          name: node.name
        })}
        message={
          node.kind === 'directory'
            ? t(
                'files.fileExplorerRowActions.deleteFolderDetail',
                'This permanently deletes the folder and its contents. This cannot be undone.'
              )
            : t(
                'files.fileExplorerRowActions.deleteFileDetail',
                'This permanently deletes the file. This cannot be undone.'
              )
        }
        confirmLabel={t('common.delete', 'Delete')}
        destructive
        onCancel={close}
        onConfirm={() => deleteNode(node)}
      />
    )
  }

  return {
    openRowActions: (node: TreeNode) => {
      if (canMutate) {
        void preloadNameSheet()
      }
      open({ kind: 'menu', node })
    },
    /** Null when the host takes no writes from a phone. */
    openCreate: canMutate
      ? (type: CreateKind, parent: string) => open({ kind: 'create', parent, type })
      : null,
    /** Upload / New File / New Folder at the root as a sheet, for a panel without the header menu; null without writes. */
    openNewChoice:
      canMutate || writes.upload
        ? () => {
            void preloadNameSheet()
            open({ kind: 'new' })
          }
        : null,
    rowActionsSheet: (
      <BottomDrawer visible={view != null} onClose={close}>
        {content}
      </BottomDrawer>
    )
  }
}

/** A long-pressed row's actions, named like the desktop File Explorer menu. */
function RowActionsMenu({
  node,
  canMutate,
  blockedOffline,
  share,
  onOpen,
  onDuplicate,
  onUpload,
  onClose
}: {
  node: TreeNode
  canMutate: boolean
  blockedOffline: boolean
  /** Null for folders and on shells that can't share. */
  share: { loading: boolean; onPress: () => void } | null
  onOpen: (view: SheetView) => void
  onDuplicate: (node: TreeNode) => void
  onUpload: ((parent: string) => void) | null
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const isDirectory = node.kind === 'directory'
  const copyAction = (id: string, label: string, text: string): ActionSheetAction => ({
    id,
    group: 'copy',
    label,
    icon: Copy,
    onPress: () => {
      onClose()
      void clipboard.writeText(text).then(triggerSuccess, triggerError)
    }
  })
  const writes: ActionSheetAction[] = !canMutate
    ? []
    : [
        ...(isDirectory
          ? [
              {
                id: 'newFile',
                group: 'new',
                label: t('files.fileExplorerRowActions.newFile', 'New File'),
                icon: FilePlus2,
                onPress: () => onOpen({ kind: 'create', parent: node.relativePath, type: 'file' })
              },
              {
                id: 'newFolder',
                group: 'new',
                label: t('files.fileExplorerRowActions.newFolder', 'New Folder'),
                icon: FolderPlus,
                onPress: () => onOpen({ kind: 'create', parent: node.relativePath, type: 'folder' })
              }
            ]
          : []),
        {
          id: 'rename',
          group: 'change',
          label: t('files.fileExplorerRowActions.rename', 'Rename'),
          icon: Edit3,
          onPress: () => onOpen({ kind: 'rename', node })
        },
        // Desktop duplicates files only.
        ...(isDirectory
          ? []
          : [
              {
                id: 'duplicate',
                group: 'change',
                label: t('files.fileExplorerRowActions.duplicate', 'Duplicate'),
                icon: CopyPlus,
                disabled: blockedOffline,
                onPress: () => onDuplicate(node)
              }
            ])
      ]
  const actions: ActionSheetAction[] = [
    ...(isDirectory && onUpload
      ? [
          {
            id: 'upload',
            group: 'new',
            label: t('files.fileExplorerRowActions.uploadHere', 'Upload Here'),
            icon: Upload,
            onPress: () => {
              onClose()
              onUpload(node.relativePath)
            }
          }
        ]
      : []),
    ...(share
      ? [
          {
            id: 'share',
            group: 'share',
            label: t('files.fileExplorerRowActions.share', 'Share'),
            icon: Share,
            loading: share.loading,
            onPress: share.onPress
          }
        ]
      : []),
    ...writes,
    copyAction('copyName', t('files.fileExplorerRowActions.copyName', 'Copy Name'), node.name),
    copyAction(
      'copyRelativePath',
      t('files.fileExplorerRowActions.copyRelativePath', 'Copy Relative Path'),
      node.relativePath
    ),
    ...(canMutate
      ? [
          {
            id: 'delete',
            group: 'delete',
            label: t('common.delete', 'Delete'),
            icon: Trash2,
            destructive: true,
            onPress: () => onOpen({ kind: 'delete', node })
          }
        ]
      : [])
  ]
  return <ActionSheetContent title={node.name} actions={actions} />
}

export type NameSheetView = Extract<SheetView, { kind: 'create' } | { kind: 'rename' }>
