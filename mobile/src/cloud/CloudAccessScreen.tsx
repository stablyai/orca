import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Smartphone } from 'lucide-react-native'
import { useState } from 'react'
import { ConfirmModal } from '../components/ConfirmModal'
import { ListRow } from '../components/list/ListGroup'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  SettingsEmptyRow,
  SettingsNote,
  SettingsScreen,
  SettingsSection
} from '../settings/settings-screen-frame'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { listCloudDeviceSessions, revokeCloudDeviceSession } from './cloud-control-plane-access'
import {
  forgetAllCloudAccess,
  forgetRevokedCloudSession,
  loadCloudControlPlane,
  useCloudHostRemoval
} from './cloud-session'
import { useCloudEnrollment } from './use-cloud-workspaces'

function formatDay(ms: number | null | undefined): string {
  return ms
    ? new Date(ms).toLocaleDateString(getUiIntlLocale(), { month: 'short', day: 'numeric' })
    : ''
}

/** Which phones hold Orca Cloud access as this user; any of them can be cut off from here. */
export function CloudAccessScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const removal = useCloudHostRemoval()
  const enrollment = useCloudEnrollment()
  // The target outlives `open` so the dialog keeps its title while it animates closed.
  const [confirm, setTarget] = useState<{ id: string; label: string; self: boolean } | null>(null)
  const [open, setOpen] = useState(false)
  const setConfirm = (target: { id: string; label: string; self: boolean } | null) => {
    if (target) {
      setTarget(target)
    }
    setOpen(target !== null)
  }
  const [error, setError] = useState<string | null>(null)
  const sessions = useQuery({
    queryKey: ['orca-cloud', 'device-sessions', enrollment?.deviceSessionId ?? null],
    enabled: Boolean(enrollment),
    queryFn: async () => {
      const plane = await loadCloudControlPlane()
      if (!plane) {
        return []
      }
      try {
        return await listCloudDeviceSessions(plane)
      } catch (failure) {
        await forgetRevokedCloudSession(failure, removal)
        throw failure
      }
    }
  })

  const revoke = async (target: { id: string; self: boolean }) => {
    setConfirm(null)
    setError(null)
    const plane = await loadCloudControlPlane()
    try {
      if (plane) {
        await revokeCloudDeviceSession(plane, target.id)
      }
    } catch (failure) {
      // Already revoked is the outcome we wanted; anything else for another phone is shown.
      if (!(await forgetRevokedCloudSession(failure, removal)) && !target.self) {
        setError(t('cloud.access.revokeFailed', 'Couldn’t remove that phone. Try again.'))
        return
      }
    }
    if (!target.self) {
      void sessions.refetch()
      return
    }
    // This phone keeps nothing: every cloud pairing goes, then the session and key.
    await forgetAllCloudAccess(removal)
    router.back()
  }

  const others = (sessions.data ?? []).filter((session) => !session.current)
  return (
    <SettingsScreen
      title={t('cloud.access.title', 'Orca Cloud access')}
      onBack={() => router.back()}
      overlays={
        <ConfirmModal
          visible={open}
          title={
            confirm?.self
              ? t('cloud.access.disconnectTitle', 'Disconnect this phone?')
              : t('cloud.access.removeTitle', 'Remove {{device}}?', {
                  device: confirm?.label ?? ''
                })
          }
          message={
            confirm?.self
              ? t(
                  'cloud.access.disconnectMessage',
                  'This phone loses access to your cloud workspaces right away. They keep running.'
                )
              : t(
                  'cloud.access.removeMessage',
                  'That phone loses access to your cloud workspaces on its next request.'
                )
          }
          confirmLabel={
            confirm?.self
              ? t('cloud.access.disconnect', 'Disconnect')
              : t('cloud.access.remove', 'Remove')
          }
          destructive
          onConfirm={() => confirm && void revoke(confirm)}
          onCancel={() => setConfirm(null)}
        />
      }
    >
      <SettingsSection
        first
        title={t('cloud.access.thisPhone', 'This phone')}
        footer={t(
          'cloud.access.thisPhoneNote',
          'It signs its own requests with a key that never leaves it. No password or token is stored.'
        )}
      >
        {enrollment ? (
          <ListRow
            key="self"
            leading={<Smartphone size={18} color={colors.textSecondary} />}
            title={enrollment.label}
            subtitle={
              enrollment.viaHostName
                ? t('cloud.access.connectedVia', 'Connected {{date}} through {{desktop}}', {
                    date: formatDay(enrollment.enrolledAt),
                    desktop: enrollment.viaHostName
                  })
                : t('cloud.access.since', 'Connected {{date}}', {
                    date: formatDay(enrollment.enrolledAt)
                  })
            }
          />
        ) : (
          <SettingsEmptyRow key="none">
            {t('cloud.access.notConnected', 'Not connected to Orca Cloud.')}
          </SettingsEmptyRow>
        )}
      </SettingsSection>
      {enrollment ? (
        <SettingsSection title={t('cloud.access.otherPhones', 'Other phones')}>
          {others.length === 0 ? (
            <SettingsEmptyRow key="empty">
              {sessions.isPending
                ? t('common.loading', 'Loading…')
                : t('cloud.access.noOthers', 'No other phones have access.')}
            </SettingsEmptyRow>
          ) : (
            others.map((session) => (
              <ListRow
                key={session.id}
                leading={<Smartphone size={18} color={colors.textSecondary} />}
                title={session.label}
                subtitle={
                  session.lastUsedAt
                    ? t('cloud.access.lastUsed', 'Last used {{date}}', {
                        date: formatDay(session.lastUsedAt)
                      })
                    : t('cloud.access.since', 'Connected {{date}}', {
                        date: formatDay(session.createdAt)
                      })
                }
                onPress={() => setConfirm({ id: session.id, label: session.label, self: false })}
                accessibilityLabel={t('cloud.access.removeLabel', 'Remove {{device}}', {
                  device: session.label
                })}
              />
            ))
          )}
        </SettingsSection>
      ) : null}
      {enrollment ? (
        <SettingsSection>
          <ListRow
            key="disconnect"
            title={t('cloud.access.disconnectThis', 'Disconnect this phone')}
            destructive
            onPress={() =>
              setConfirm({ id: enrollment.deviceSessionId, label: enrollment.label, self: true })
            }
          />
        </SettingsSection>
      ) : null}
      {error ? <SettingsNote error>{error}</SettingsNote> : null}
    </SettingsScreen>
  )
}
