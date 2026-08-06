import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { BottomDrawer } from '../components/BottomDrawer'
import { MobileSyntaxSegments } from '../components/MobileSyntaxSegments'
import { mobileDiffLineNumber, mobileDiffLinePrefix } from './mobile-diff-format'
import type { MobileBranchDiffPreviewState } from './mobile-source-control-screen-state'
import { styles } from './mobile-source-control-styles'
import { t } from '@/i18n/mobile-i18n'

type Props = {
  branchDiffPreview: MobileBranchDiffPreviewState | null
  onClose: () => void
}

export function MobileBranchDiffPreviewDrawer({ branchDiffPreview, onClose }: Props) {
  if (!branchDiffPreview) {
    return null
  }
  const entry = branchDiffPreview.entry
  return (
    <BottomDrawer
      visible={branchDiffPreview !== null}
      onClose={onClose}
      dragContentToDismiss={false}
      zIndex={1100}
    >
      <View style={styles.diffDrawerHeader}>
        <View style={styles.diffDrawerTitleBlock}>
          <Text style={styles.diffDrawerTitle} numberOfLines={1}>
            {entry.path}
          </Text>
          <Text style={styles.diffDrawerMeta} numberOfLines={1}>
            {branchDiffPreview.kind === 'ready'
              ? t('mobileBranchDiffPreviewDrawer.base', {
                  baseRef: branchDiffPreview.summary.baseRef
                })
              : t('mobileBranchDiffPreviewDrawer.committed')}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.diffCloseButton, pressed && styles.iconButtonPressed]}
          onPress={onClose}
          hitSlop={8}
          accessibilityLabel={t('mobileBranchDiffPreviewDrawer.close')}
        >
          <X size={18} color={colors.textSecondary} strokeWidth={2.1} />
        </Pressable>
      </View>
      {branchDiffPreview.kind === 'loading' ? (
        <View style={styles.diffState}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : branchDiffPreview.kind === 'error' ? (
        <View style={styles.diffState}>
          <Text style={styles.stateTitle}>{t('mobileBranchDiffPreviewDrawer.unable')}</Text>
          <Text style={styles.stateText}>{branchDiffPreview.message}</Text>
        </View>
      ) : (
        <View style={styles.diffLines}>
          {branchDiffPreview.truncated ? (
            <Text style={styles.diffTruncatedText}>{t('mobileBranchDiffPreviewDrawer.diff')}</Text>
          ) : null}
          {branchDiffPreview.lines.map((line, index) => (
            <View
              key={`${index}:${line.kind}:${line.oldLineNumber ?? ''}:${line.newLineNumber ?? ''}`}
              style={[
                styles.diffLine,
                line.kind === 'add' && styles.diffLineAdd,
                line.kind === 'delete' && styles.diffLineDelete
              ]}
            >
              <Text style={styles.diffLineNumber}>{mobileDiffLineNumber(line)}</Text>
              <Text style={styles.diffLinePrefix}>{mobileDiffLinePrefix(line.kind)}</Text>
              <Text style={styles.diffLineText}>
                {line.text ? <MobileSyntaxSegments segments={line.segments} /> : ' '}
              </Text>
            </View>
          ))}
        </View>
      )}
    </BottomDrawer>
  )
}
