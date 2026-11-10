import { Archive, Moon } from 'lucide-react-native'
import { useState } from 'react'
import { View } from 'react-native'
import { ConfirmModal } from '../components/ConfirmModal'
import { ListRow } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { CloudWorkspace } from './cloud-control-plane-client'
import { cloudWorkspaceScreenStyles as styles } from './cloud-workspace-screen-styles'

/** Sleep (no sandbox hours, files kept) and Archive, each behind a confirm because both stop agents. */
export function CloudWorkspaceActions(props: {
  workspace: CloudWorkspace
  busy: 'sleep' | 'archive' | null
  disabled: boolean
  onSleep: () => void
  onArchive: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // The kind outlives `open` so the dialog keeps its own title while it animates closed.
  const [kind, setKind] = useState<'sleep' | 'archive'>('sleep')
  const [open, setOpen] = useState(false)
  const ask = (next: 'sleep' | 'archive') => {
    setKind(next)
    setOpen(true)
  }
  const running = props.workspace.status === 'running'
  return (
    <>
      {running ? (
        <View style={styles.section}>
          <View style={styles.card}>
            <ListRow
              key="sleep"
              leading={<Moon size={18} color={colors.textSecondary} />}
              title={t('cloud.actions.sleep', 'Sleep')}
              subtitle={t(
                'cloud.actions.sleepCaption',
                'Sandbox hours stop. Files are kept; agents restart when it wakes.'
              )}
              busy={props.busy === 'sleep'}
              disabled={props.disabled}
              onPress={() => ask('sleep')}
            />
          </View>
        </View>
      ) : null}
      <View style={styles.section}>
        <View style={styles.card}>
          <ListRow
            key="archive"
            leading={<Archive size={18} color={colors.textSecondary} />}
            title={t('cloud.actions.archive', 'Archive')}
            busy={props.busy === 'archive'}
            disabled={props.disabled || props.workspace.status === 'archived'}
            onPress={() => ask('archive')}
          />
        </View>
      </View>
      <ConfirmModal
        visible={open}
        title={
          kind === 'sleep'
            ? t('cloud.sleep.title', 'Sleep {{title}}?', { title: props.workspace.title })
            : t('cloud.archive.title', 'Archive {{title}}?', { title: props.workspace.title })
        }
        message={
          kind === 'sleep'
            ? t(
                'cloud.sleep.message',
                'Running agents stop now and restart when you wake it. Files are kept.'
              )
            : t(
                'cloud.archive.message',
                'It goes to sleep and keeps a snapshot you can unarchive. Unpushed work stays in that snapshot.'
              )
        }
        confirmLabel={
          kind === 'sleep'
            ? t('cloud.sleep.confirm', 'Sleep')
            : t('cloud.archive.confirm', 'Archive')
        }
        onConfirm={() => {
          setOpen(false)
          if (kind === 'sleep') {
            props.onSleep()
          } else {
            props.onArchive()
          }
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  )
}
