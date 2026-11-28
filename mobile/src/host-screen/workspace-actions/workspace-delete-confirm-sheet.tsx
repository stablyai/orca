import { Pressable, Text, View } from 'react-native'
import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import { folderIdOfSelector } from '../../../../src/shared/workspace/identity/workspace-scope'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { hostScreenStylesSheet } from '../host-screen-styles'
import { useWorkspaceDeleteLoss, type WorkspaceDeleteLoss } from './workspace-delete-loss'
import { useThemedStyles } from '../../theme/themed-styles'

type Translate = ReturnType<typeof useMobileTranslation>

/** Desktop's loss line: what deleting this worktree throws away, or null when nothing is at risk. */
function lossLine(loss: WorkspaceDeleteLoss, t: Translate): string | null {
  if (loss.kind !== 'known') {
    return null
  }
  const changes =
    loss.changeCount > 0
      ? t('hostScreen.deleteConfirm.changes', '{{count}} uncommitted changes', {
          count: loss.changeCount,
          defaultValue_one: '{{count}} uncommitted change'
        })
      : null
  const ignored = (loss.ignoredFiles?.count ?? 0) > 0
  if (changes && ignored) {
    return t(
      'hostScreen.deleteConfirm.changesAndIgnoredLost',
      '{{what}} and ignored files will be lost',
      {
        what: changes
      }
    )
  }
  if (changes) {
    return t('hostScreen.deleteConfirm.lost', '{{what}} will be lost', { what: changes })
  }
  return ignored ? t('hostScreen.deleteConfirm.ignoredLost', 'Ignored files will be lost') : null
}

function lossDetail(loss: WorkspaceDeleteLoss, t: Translate): string | null {
  if (loss.kind === 'checking') {
    return t('hostScreen.deleteConfirm.checking', 'Checking for changes…')
  }
  if (loss.kind === 'unchecked') {
    return t('hostScreen.deleteConfirm.unchecked', 'Changes could not be checked')
  }
  const files = loss.kind === 'known' ? loss.ignoredFiles : null
  if (!files || files.samplePaths.length === 0) {
    // A scan cut short by a time, size or git limit leaves the rest unknown, never safe.
    return files?.complete === false
      ? t('hostScreen.deleteConfirm.ignoredUnchecked', 'Ignored files could not be fully checked')
      : null
  }
  const names = files.samplePaths.join(', ')
  const more = files.count - files.samplePaths.length
  if (!files.complete) {
    return t('hostScreen.deleteConfirm.ignoredNamesMore', '{{names}} and more', { names })
  }
  return more > 0
    ? t('hostScreen.deleteConfirm.ignoredNamesCount', '{{names}} +{{value0}}', {
        names,
        value0: more
      })
    : names
}

/** The delete confirm: a folder row only leaves Orca; a worktree first says what it loses, as desktop does. */
export function WorkspaceDeleteConfirmSheet(props: {
  row: Worktree
  hostId: string
  rowClient: RpcClient | null
  routeHost: ExecutionHostId | undefined
  onCancel: () => void
  onDelete: () => void
}) {
  const styles = useThemedStyles(hostScreenStylesSheet)
  const { row, onCancel, onDelete } = props
  const t = useMobileTranslation()
  const loss = useWorkspaceDeleteLoss(props)
  const name = row.displayName || row.repo
  const isFolder = folderIdOfSelector(row.worktreeId) !== undefined
  const line = lossLine(loss, t)
  const detail = lossDetail(loss, t)
  return (
    <View>
      <View style={styles.confirmContent}>
        <Text style={styles.confirmTitle}>
          {isFolder
            ? t('hostScreen.deleteConfirm.removeTitle', 'Remove workspace')
            : t('common.delete', 'Delete')}
        </Text>
        <Text style={styles.confirmMessage}>
          {isFolder
            ? t(
                'hostScreen.deleteConfirm.removeFolderMessage',
                'Remove "{{name}}" from Orca? The folder on disk is kept.',
                { name }
              )
            : t(
                'hostScreen.hostScreenOverlays.deleteConfirmMessage',
                'Delete "{{name}}" ({{branch}})?',
                {
                  name,
                  branch: row.branch
                }
              )}
        </Text>
        {row.recipeEnvironment ? (
          <Text style={styles.confirmMessage}>
            {row.recipeEnvironment.destroys === false
              ? t(
                  'hostScreen.hostScreenOverlays.deleteKeepsEnvironment',
                  'The environment "{{environment}}" that Orca created for it keeps running: its recipe has no destroy step.',
                  { environment: row.recipeEnvironment.name }
                )
              : t(
                  'hostScreen.hostScreenOverlays.deleteDestroysEnvironment',
                  'This also destroys the environment "{{environment}}" that Orca created for it, with any uncommitted work and running terminals on it.',
                  { environment: row.recipeEnvironment.name }
                )}
          </Text>
        ) : null}
        {line ? <Text style={[styles.confirmMessage, styles.confirmLoss]}>{line}</Text> : null}
        {detail ? (
          <Text style={styles.confirmDetail} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      <View style={styles.confirmButtons}>
        <Pressable
          style={({ pressed }) => [
            styles.confirmBtn,
            styles.confirmBtnCancel,
            pressed && styles.confirmBtnPressed
          ]}
          onPress={onCancel}
        >
          <Text style={styles.confirmBtnCancelText}>{t('common.cancel', 'Cancel')}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.confirmBtn,
            styles.confirmBtnDestructive,
            pressed && styles.confirmBtnPressed
          ]}
          onPress={onDelete}
        >
          <Text style={styles.confirmBtnDestructiveText}>
            {isFolder ? t('common.remove', 'Remove') : t('common.delete', 'Delete')}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}
