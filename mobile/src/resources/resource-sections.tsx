import { Text, View } from 'react-native'
import { formatBytes } from '../../../src/shared/format-bytes'
import type { HostResourcesSnapshot, HostResourcesVolume } from '../../../src/shared/host-resources'
import { ListGroup, SectionHeader } from '../components/list/ListGroup'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { styles } from './mobile-resources-screen-styles'
import { CoreBars, CpuRing, CpuSparkline, ResourceMeter } from './resource-meters'

export function ResourcesSections({
  snapshot,
  cpuHistory,
  now
}: {
  snapshot: HostResourcesSnapshot
  cpuHistory: readonly number[]
  now: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const roundedCpu =
    snapshot.cpu.percent === null ? null : Math.round(clampPercent(snapshot.cpu.percent))
  const coreLabel =
    snapshot.cpu.coreCount === 1
      ? t('resources.screen.cores_one', '{{count}} core', { count: snapshot.cpu.coreCount })
      : t('resources.screen.cores_other', '{{count}} cores', { count: snapshot.cpu.coreCount })
  const model = snapshot.cpu.model.trim()
  const seenRoles = new Map<HostResourcesVolume['role'], number>()

  return (
    <>
      <SectionHeader title={t('resources.screen.cpu', 'CPU')} first />
      <ListGroup style={styles.group}>
        <View style={styles.block}>
          <View style={styles.cpuRow}>
            <CpuRing percent={roundedCpu} />
            <View style={styles.cpuFacts}>
              <Text style={styles.body}>{coreLabel}</Text>
              {model !== '' ? (
                <Text style={styles.model} numberOfLines={2}>
                  {model}
                </Text>
              ) : null}
              {snapshot.cpu.loadAverage1m !== null ? (
                <Text style={styles.meta}>
                  {t('resources.screen.loadAverage', 'Load {{load}}', {
                    load: snapshot.cpu.loadAverage1m.toFixed(1)
                  })}
                </Text>
              ) : null}
            </View>
          </View>
          <CpuSparkline samples={cpuHistory} />
          <CoreBars cores={snapshot.cpu.cores} />
        </View>
      </ListGroup>

      <SectionHeader title={t('resources.screen.memory', 'Memory')} />
      <ListGroup style={styles.group}>
        <ResourceMeter
          caption={t('resources.screen.bytesOf', '{{used}} of {{total}}', {
            used: formatBytes(snapshot.memory.usedBytes),
            total: formatBytes(snapshot.memory.totalBytes)
          })}
          usedPercent={snapshot.memory.usedPercent}
          accessibilityLabel={t(
            'resources.screen.memoryMeter',
            '{{used}} of {{total}}, {{percent}} percent',
            {
              used: formatBytes(snapshot.memory.usedBytes),
              total: formatBytes(snapshot.memory.totalBytes),
              percent: Math.round(clampPercent(snapshot.memory.usedPercent))
            }
          )}
        />
        {snapshot.memory.swap !== null ? (
          <ResourceMeter
            quiet
            label={t('resources.screen.swap', 'Swap')}
            caption={t('resources.screen.bytesOf', '{{used}} of {{total}}', {
              used: formatBytes(snapshot.memory.swap.usedBytes),
              total: formatBytes(snapshot.memory.swap.totalBytes)
            })}
            usedPercent={snapshot.memory.swap.usedPercent}
            accessibilityLabel={t(
              'resources.screen.swapMeter',
              'Swap {{used}} of {{total}}, {{percent}} percent',
              {
                used: formatBytes(snapshot.memory.swap.usedBytes),
                total: formatBytes(snapshot.memory.swap.totalBytes),
                percent: Math.round(clampPercent(snapshot.memory.swap.usedPercent))
              }
            )}
          />
        ) : null}
      </ListGroup>

      <SectionHeader title={t('resources.screen.disk', 'Disk')} />
      <ListGroup style={styles.group}>
        {snapshot.volumes.length === 0 ? (
          <Text style={styles.empty}>{t('resources.screen.noDisks', 'No disks reported')}</Text>
        ) : (
          snapshot.volumes.map((volume, index) => {
            const occurrence = seenRoles.get(volume.role) ?? 0
            seenRoles.set(volume.role, occurrence + 1)
            const label = volumeTitle(volume.role, occurrence, t)
            const free = formatBytes(volume.freeBytes)
            const total = formatBytes(volume.totalBytes)
            const percent = Math.round(clampPercent(volume.usedPercent))
            return (
              <ResourceMeter
                key={`${volume.role}-${index}`}
                label={label}
                caption={t('resources.screen.volumeFree', '{{free}} free of {{total}}', {
                  free,
                  total
                })}
                usedPercent={volume.usedPercent}
                accessibilityLabel={t(
                  'resources.screen.volumeMeter',
                  '{{label}}, {{free}} free of {{total}}, {{percent}} percent',
                  { label, free, total, percent }
                )}
              />
            )
          })
        )}
      </ListGroup>

      <Text style={styles.footer}>
        {uptimeCopy(snapshot.uptimeSeconds, t)}
        {'\n'}
        {updatedCopy(snapshot.sampledAt, now, t)}
      </Text>
    </>
  )
}

function volumeTitle(role: HostResourcesVolume['role'], occurrence: number, t: Translate): string {
  let base = t('resources.screen.volumeHomeAndWorkspace', 'Home and workspace')
  if (role === 'home') {
    base = t('resources.screen.volumeHome', 'Home')
  } else if (role === 'workspace') {
    base = t('resources.screen.volumeWorkspace', 'Workspace')
  }
  if (occurrence === 0) {
    return base
  }
  return t('resources.screen.volumeNumbered', '{{label}} {{index}}', {
    label: base,
    index: occurrence + 1
  })
}

function uptimeCopy(seconds: number, t: Translate): string {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes - days * 24 * 60) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) {
    return t('resources.screen.uptimeDays', 'Up {{days}}d {{hours}}h', { days, hours })
  }
  if (hours > 0) {
    return t('resources.screen.uptimeHours', 'Up {{hours}}h {{minutes}}m', { hours, minutes })
  }
  return t('resources.screen.uptimeMinutes', 'Up {{minutes}}m', { minutes })
}

function updatedCopy(sampledAt: number, now: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor((now - sampledAt) / 1000))
  if (seconds < 1) {
    return t('resources.screen.updatedJustNow', 'Updated just now')
  }
  return t('resources.screen.updatedSecondsAgo', 'Updated {{seconds}}s ago', { seconds })
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}
