import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { themedStyleSheet } from '../theme/themed-styles'
import { colors, spacing, typography } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc-client'
import { hostScreenStyles as styles } from '../host-screen/host-screen-styles'
import {
  multiRepoDelete,
  multiRepoInspectDelete
} from '../worktree/multi-repo-workspace-operations'
import type {
  MultiRepoDeleteInspectionReply,
  MultiRepoDeleteResultReply
} from '../worktree/multi-repo-workspace-reply-schema'
import {
  multiRepoDeleteBlockedByChanges,
  multiRepoDeleteOutcomeText,
  multiRepoDeleteRowStatus,
  multiRepoRootKeptText
} from '../worktree/multi-repo-delete-sheet-model'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { BottomDrawer } from './BottomDrawer'

const DELETE_TIMEOUT_MS = 120_000

type Phase =
  | { kind: 'inspecting' }
  | { kind: 'ready'; inspection: MultiRepoDeleteInspectionReply }
  | { kind: 'deleting'; inspection: MultiRepoDeleteInspectionReply }
  | {
      kind: 'done'
      inspection: MultiRepoDeleteInspectionReply
      result: MultiRepoDeleteResultReply
    }
  | { kind: 'error'; message: string }

type Props = {
  client: RpcClient | null
  folderWorkspaceId: string | null
  workspaceName: string
  memberNames: ReadonlyMap<string, string>
  onClose: () => void
}

export function MultiRepoDeleteSheet({
  client,
  folderWorkspaceId,
  workspaceName,
  memberNames,
  onClose
}: Props) {
  const t = useMobileTranslation()
  const [phase, setPhase] = useState<Phase>({ kind: 'inspecting' })
  const requestIdRef = useRef(0)

  const inspect = useCallback(async () => {
    if (!folderWorkspaceId) {
      return
    }
    if (!client) {
      requestIdRef.current += 1
      setPhase({
        kind: 'error',
        message: t(
          'components.multiRepoDeleteSheet.hostUnavailable',
          'This host is not available for workspace deletion'
        )
      })
      return
    }
    const requestId = ++requestIdRef.current
    setPhase({ kind: 'inspecting' })
    try {
      const reply = await multiRepoInspectDelete.request(client, { folderWorkspaceId })
      const inspection = multiRepoInspectDelete.interpret(reply)
      if (requestId === requestIdRef.current) {
        setPhase({ kind: 'ready', inspection })
      }
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setPhase({
          kind: 'error',
          message:
            error instanceof Error
              ? error.message
              : t('components.multiRepoDeleteSheet.checkFailed', 'Could not check the workspace')
        })
      }
    }
  }, [client, folderWorkspaceId, t])

  useEffect(() => {
    if (folderWorkspaceId) {
      void inspect()
    }
    return () => {
      requestIdRef.current += 1
    }
  }, [folderWorkspaceId, inspect])

  const runDelete = useCallback(
    async (inspection: MultiRepoDeleteInspectionReply) => {
      if (!client || !folderWorkspaceId) {
        return
      }
      const requestId = ++requestIdRef.current
      setPhase({ kind: 'deleting', inspection })
      try {
        // No forceMemberIds from a phone: the host also refuses it for paired clients.
        const reply = await multiRepoDelete.request(
          client,
          { folderWorkspaceId },
          { timeoutMs: DELETE_TIMEOUT_MS }
        )
        const result = multiRepoDelete.interpret(reply)
        if (requestId === requestIdRef.current) {
          setPhase({ kind: 'done', inspection, result })
        }
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setPhase({
            kind: 'error',
            message:
              error instanceof Error
                ? error.message
                : t(
                    'components.multiRepoDeleteSheet.deleteFailed',
                    'Could not delete the workspace'
                  )
          })
        }
      }
    },
    [client, folderWorkspaceId, t]
  )

  const nameOf = (memberId: string, repoId: string): string => memberNames.get(memberId) ?? repoId

  const body = (() => {
    switch (phase.kind) {
      case 'inspecting':
        return (
          <View style={localStyles.centered}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={localStyles.muted}>
              {t('components.multiRepoDeleteSheet.checking', 'Checking {{name}}…', {
                name: workspaceName
              })}
            </Text>
          </View>
        )
      case 'error':
        return (
          <View>
            <View style={styles.confirmContent}>
              <Text style={styles.confirmTitle}>
                {t('components.multiRepoDeleteSheet.deleteTitle', 'Delete {{name}}?', {
                  name: workspaceName
                })}
              </Text>
              <Text style={styles.confirmMessage}>{phase.message}</Text>
            </View>
            <View style={styles.confirmButtons}>
              <SheetButton
                label={t('components.multiRepoDeleteSheet.close', 'Close')}
                onPress={onClose}
              />
              <SheetButton
                label={t('components.multiRepoDeleteSheet.checkAgain', 'Check again')}
                onPress={() => void inspect()}
              />
            </View>
          </View>
        )
      case 'ready':
      case 'deleting': {
        const { inspection } = phase
        const blocked = multiRepoDeleteBlockedByChanges(inspection.members)
        const deleting = phase.kind === 'deleting'
        const count = inspection.members.length
        return (
          <View>
            <View style={styles.confirmContent}>
              <Text style={styles.confirmTitle}>
                {t('components.multiRepoDeleteSheet.deleteTitle', 'Delete {{name}}?', {
                  name: workspaceName
                })}
              </Text>
              <Text style={styles.confirmMessage}>
                {t(
                  'components.multiRepoDeleteSheet.removesWorktrees_other',
                  'This removes {{count}} worktrees and the workspace folder if it is empty. Branches that are fully merged are deleted; branches with unmerged commits are kept.',
                  { count }
                )}
              </Text>
              {inspection.members.map((member) => {
                const status = multiRepoDeleteRowStatus(member)
                return (
                  <View key={member.memberId} style={localStyles.row}>
                    <Text style={localStyles.rowName} numberOfLines={1}>
                      {nameOf(member.memberId, member.repoId)}
                    </Text>
                    <Text style={[localStyles.rowStatus, status.risky && localStyles.risky]}>
                      {status.text}
                    </Text>
                  </View>
                )
              })}
              {blocked ? (
                <Text style={[styles.confirmMessage, localStyles.risky]}>
                  {t(
                    'components.multiRepoDeleteSheet.deleteFromDesktop',
                    'Delete from desktop to discard changes.'
                  )}
                </Text>
              ) : null}
            </View>
            <View style={styles.confirmButtons}>
              <SheetButton
                label={t('components.multiRepoDeleteSheet.cancel', 'Cancel')}
                onPress={onClose}
                disabled={deleting}
              />
              <SheetButton
                label={
                  deleting
                    ? t('components.multiRepoDeleteSheet.deleting', 'Deleting…')
                    : t('components.multiRepoDeleteSheet.delete', 'Delete')
                }
                destructive
                disabled={blocked || deleting}
                onPress={() => void runDelete(inspection)}
              />
            </View>
          </View>
        )
      }
      case 'done': {
        const { result } = phase
        const failed = result.members.filter((member) => member.status === 'failed').length
        return (
          <View>
            <View style={styles.confirmContent}>
              <Text style={styles.confirmTitle}>
                {result.workspaceRemoved
                  ? t('components.multiRepoDeleteSheet.deleted', '{{name}} deleted', {
                      name: workspaceName
                    })
                  : t(
                      'components.multiRepoDeleteSheet.notFullyDeleted',
                      '{{name}} not fully deleted',
                      {
                        name: workspaceName
                      }
                    )}
              </Text>
              {result.members.map((member) => (
                <View key={member.memberId} style={localStyles.row}>
                  <Text style={localStyles.rowName} numberOfLines={1}>
                    {nameOf(
                      member.memberId,
                      phase.inspection.members.find((m) => m.memberId === member.memberId)
                        ?.repoId ?? member.memberId
                    )}
                  </Text>
                  <Text
                    style={[localStyles.rowStatus, member.status === 'failed' && localStyles.risky]}
                  >
                    {multiRepoDeleteOutcomeText(member)}
                  </Text>
                </View>
              ))}
              {result.rootKept ? (
                <Text style={styles.confirmMessage}>{multiRepoRootKeptText(result.rootKept)}</Text>
              ) : null}
            </View>
            <View style={styles.confirmButtons}>
              <SheetButton
                label={t('components.multiRepoDeleteSheet.close', 'Close')}
                onPress={onClose}
              />
              {failed > 0 ? (
                <SheetButton
                  label={t(
                    'components.multiRepoDeleteSheet.retryFailed_other',
                    'Retry {{count}} failed',
                    { count: failed }
                  )}
                  destructive
                  onPress={() => void runDelete(phase.inspection)}
                />
              ) : null}
            </View>
          </View>
        )
      }
    }
  })()

  return (
    <BottomDrawer visible={folderWorkspaceId !== null} onClose={onClose}>
      {body}
    </BottomDrawer>
  )
}

function SheetButton({
  label,
  onPress,
  destructive = false,
  disabled = false
}: {
  label: string
  onPress: () => void
  destructive?: boolean
  disabled?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.confirmBtn,
        destructive ? styles.confirmBtnDestructive : styles.confirmBtnCancel,
        (pressed || disabled) && styles.confirmBtnPressed
      ]}
      onPress={onPress}
    >
      <Text style={destructive ? styles.confirmBtnDestructiveText : styles.confirmBtnCancelText}>
        {label}
      </Text>
    </Pressable>
  )
}

const localStyles = themedStyleSheet(() => ({
  centered: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  muted: { fontSize: typography.bodySize, color: colors.textSecondary },
  row: { marginTop: spacing.sm, gap: 2 },
  rowName: { fontSize: typography.bodySize, fontWeight: '600', color: colors.textPrimary },
  rowStatus: { fontSize: typography.metaSize, color: colors.textSecondary },
  risky: { color: colors.statusAmber }
}))
