import { Cloud } from 'lucide-react-native'
import { View } from 'react-native'
import type { CloudWorkspaceStatus } from '../cloud/cloud-control-plane-client'
import { CloudStatusDot } from '../cloud/CloudStatusDot'
import { cloudStatusLabel } from '../cloud/cloud-workspace-display'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { HostKindIcon } from './HostKindIcon'

// Rows ask whether they're cloud from here, next to the glyph that draws the answer.
export { cloudWorktreeRowStatus } from '../cloud/cloud-worktree-row'

/** A paired desktop's Orca Cloud workspace in a list row: the Cloud glyph, never swapped by state,
 *  with the state on a corner dot (the cloud-icon rule; the home Cloud rows draw the same pair). */
export function WorktreeCloudGlyph({ status }: { status: CloudWorkspaceStatus | null }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const label = status
    ? t('components.worktreeListRow.cloudWorkspaceState', 'Cloud workspace, {{state}}', {
        state: cloudStatusLabel(status, t)
      })
    : t('components.worktreeListRow.cloudWorkspace', 'Cloud workspace')
  // Only a label, no focus stop of its own: it merges into the row's label, like the remote-host glyph.
  return (
    <View accessibilityLabel={label} style={styles.glyph}>
      <Cloud size={12} strokeWidth={2} color={colors.textMuted} />
      {/* No filled ring: the row's fill changes on press and when active, so a ring would show as a patch. */}
      {status ? (
        <View style={styles.dot}>
          <CloudStatusDot status={status} size={7} />
        </View>
      ) : null}
    </View>
  )
}

/** A row's leading host glyph: the Cloud glyph for an Orca Cloud workspace, else (when asked) the
 *  remote-host glyph, which an Orca Cloud workspace never also shows. */
export function WorktreeRowHostGlyph({
  cloud,
  remote,
  hostId,
  label
}: {
  cloud: { status: CloudWorkspaceStatus | null } | null
  remote: boolean
  hostId: string | undefined
  label: string
}) {
  if (cloud) {
    return <WorktreeCloudGlyph status={cloud.status} />
  }
  return remote ? (
    <View accessibilityLabel={label}>
      <HostKindIcon hostId={hostId} size={11} />
    </View>
  ) : null
}

const styles = themedStyleSheet(() => ({
  // The dot sits mostly outside the glyph's bottom-right so it never reads as part of the strokes;
  // the margin keeps it clear of the title.
  glyph: { width: 12, height: 12, marginRight: 3 },
  dot: { position: 'absolute', right: -6, bottom: -4 }
}))
