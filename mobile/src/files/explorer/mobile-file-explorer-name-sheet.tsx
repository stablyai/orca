import { useEffect, useRef } from 'react'
import { useDraftRenameSheet } from '../../components/rename/use-draft-rename-sheet'
import { TextInputSheetContent } from '../../components/sheets/TextInputModal'
import { useHostDisplay } from '../../host-descriptors/use-host-display'
import { useHostProfile } from '../../host-catalog/use-host-profile'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { triggerSuccess } from '../../platform/haptics/haptics'
import type { HostMutationHandle, HostMutationPhase } from '../../query/host-mutation'
import type {
  ExplorerWrites,
  NameSheetView,
  WritePin
} from './mobile-file-explorer-row-actions-sheet'
import type { TreeNode } from './file-tree'
import {
  childPathOf,
  parentPathOf,
  type CreateVars,
  type RenameVars
} from './mobile-file-explorer-mutations'

/** New File, New Folder and Rename: one name field over a draft-mode write that keeps the text while offline. */
export function NameSheet({
  view,
  writes,
  create,
  rename,
  pin,
  onClose
}: {
  view: NameSheetView
  writes: ExplorerWrites
  create: HostMutationHandle<CreateVars, void>
  rename: HostMutationHandle<RenameVars, void>
  pin: () => WritePin
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const { hostId, target, onCreated, onMoved } = writes
  const hostName = useHostDisplay(useHostProfile(hostId)).title
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const renaming = view.kind === 'rename' ? view.node : null
  const parent = renaming
    ? parentPathOf(renaming.relativePath)
    : view.kind === 'create'
      ? view.parent
      : ''
  const type = view.kind === 'create' ? view.type : null
  const sheet = useDraftRenameSheet({
    draftKey: JSON.stringify([
      'files-name',
      hostId,
      target,
      renaming ? renaming.relativePath : `${parent}/`,
      type
    ]),
    currentName: renaming?.name ?? '',
    blockedOffline: (renaming ? rename : create).blockedOffline,
    hostName,
    failureMessage: (reason) =>
      renaming
        ? t('files.fileExplorerRowActions.renameFailed', "Couldn't rename {{name}}. {{reason}}", {
            name: renaming.name,
            reason
          })
        : type === 'folder'
          ? t(
              'files.fileExplorerRowActions.newFolderFailed',
              "Couldn't create the folder. {{reason}}",
              {
                reason
              }
            )
          : t(
              'files.fileExplorerRowActions.newFileFailed',
              "Couldn't create the file. {{reason}}",
              {
                reason
              }
            ),
    rename: async (name: string, onPhase: (phase: HostMutationPhase) => void) => {
      const relativePath = childPathOf(parent, name)
      const written = pin()
      const options = { onPhase, route: written.route }
      if (renaming) {
        await rename.mutate({ target, from: renaming.relativePath, to: relativePath }, options)
      } else if (type) {
        await create.mutate({ target, parent, name, kind: type }, options)
      }
      if (!written.current()) {
        return
      }
      if (renaming) {
        onMoved(renaming.relativePath, relativePath)
      } else if (type) {
        onCreated(relativePath, type, mounted.current)
      }
      triggerSuccess()
    },
    onRenamed: onClose
  })

  const title = renaming
    ? t('files.fileExplorerRowActions.rename', 'Rename')
    : type === 'folder'
      ? t('files.fileExplorerRowActions.newFolder', 'New Folder')
      : t('files.fileExplorerRowActions.newFile', 'New File')
  return (
    <TextInputSheetContent
      title={title}
      // Where the new entry goes, or what is being renamed.
      subtitle={renaming ? renaming.relativePath : parent || undefined}
      placeholder={
        type === 'folder' || renaming?.kind === 'directory'
          ? t('files.fileExplorerRowActions.folderName', 'Folder name')
          : t('files.fileExplorerRowActions.fileName', 'File name')
      }
      selectTextOnFocus={renaming != null}
      // Text kept from an offline attempt is not the name, so it opens fully selected instead.
      initialSelection={
        renaming && sheet.value === renaming.name ? renameSelection(renaming) : undefined
      }
      {...sheet.sheetProps}
      submitLabel={
        sheet.sheetProps.submitLabel ??
        (renaming ? undefined : t('files.fileExplorerRowActions.create', 'Create'))
      }
      onSubmit={(name) =>
        // An unchanged name is no rename, as on desktop.
        renaming && name === renaming.name ? onClose() : void sheet.submit(name)
      }
      onCancel={onClose}
    />
  )
}

// The name without its extension, as desktop and iOS select it; a folder, a dotfile (.env) or a
// name with no extension is selected whole.
function renameSelection(node: TreeNode): { start: number; end: number } {
  const dot = node.kind === 'directory' ? -1 : node.name.lastIndexOf('.')
  return { start: 0, end: dot > 0 ? dot : node.name.length }
}
