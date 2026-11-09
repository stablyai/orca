import { Monitor, WifiOff } from 'lucide-react-native'
import { useState } from 'react'
import type { AgentListHostSummary } from '../../agents/agent-list-rows'
import { PickerModal, type PickerOption } from '../../components/PickerModal'
import { hostPickerOptions } from '../../components/use-connected-host-picker'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { HostProfile } from '../../transport/hosts/host-profile'
import { useHostDisplay } from '../../transport/hosts/use-host-display'
import { MobileHomePill } from './MobileHomeHostPill'

const ALL_DESKTOPS = '__all__'

/** The Agents tab's desktop filter: "All desktops" or one, each with its agent counts. */
export function AgentsDesktopFilter(props: {
  hosts: readonly HostProfile[]
  selected: string | null
  summaries: readonly AgentListHostSummary[]
  onSelect: (hostId: string | null) => void
}) {
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <DesktopPill hosts={props.hosts} selected={props.selected} onOpen={() => setOpen(true)} />
      <PickerModal
        visible={open}
        title={t('agents.desktops.pickerTitle', 'Show agents on')}
        options={desktopFilterOptions(props.hosts, props.summaries, t)}
        selected={props.selected ?? ALL_DESKTOPS}
        onSelect={(value) => props.onSelect(value === ALL_DESKTOPS ? null : value)}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

function desktopFilterOptions(
  hosts: readonly HostProfile[],
  summaries: readonly AgentListHostSummary[],
  t: Translate
): PickerOption[] {
  const agentCount = (count: number) =>
    count === 1
      ? t('agents.desktops.agents_one', '{{count}} agent', { count })
      : t('agents.desktops.agents_other', '{{count}} agents', { count })
  const total = summaries.reduce((sum, summary) => sum + summary.agents, 0)
  const icon = (offline: boolean) => () =>
    offline ? (
      <WifiOff size={17} color={colors.textMuted} />
    ) : (
      <Monitor size={17} color={colors.textPrimary} />
    )
  return [
    {
      value: ALL_DESKTOPS,
      label: t('agents.desktops.all', 'All desktops'),
      subtitle: agentCount(total),
      renderIcon: icon(false)
    },
    ...hostPickerOptions([...hosts]).map((option) => {
      const summary = summaries.find((entry) => entry.hostId === option.value)
      const needsYou = summary?.needsYou ?? 0
      return {
        value: option.value,
        label: option.label,
        subtitle: summary?.offline
          ? t('agents.desktops.offline', 'Offline')
          : [
              agentCount(summary?.agents ?? 0),
              needsYou > 0
                ? needsYou === 1
                  ? t('agents.desktops.needsYou_one', '{{count}} needs you', { count: needsYou })
                  : t('agents.desktops.needsYou_other', '{{count}} need you', { count: needsYou })
                : null
            ]
              .filter(Boolean)
              .join(' · '),
        renderIcon: icon(summary?.offline ?? false)
      }
    })
  ]
}

function DesktopPill(props: {
  hosts: readonly HostProfile[]
  selected: string | null
  onOpen: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const selected = props.hosts.find((host) => host.id === props.selected) ?? null
  const title = useHostDisplay(selected).title
  const label = selected ? title : t('agents.desktops.all', 'All desktops')
  return (
    <MobileHomePill
      label={label}
      leading={<Monitor size={14} color={colors.textPrimary} />}
      accessibilityLabel={t('home.tabs.chooseDesktop', '{{desktop}}, choose another desktop', {
        desktop: label
      })}
      onPress={props.onOpen}
    />
  )
}
