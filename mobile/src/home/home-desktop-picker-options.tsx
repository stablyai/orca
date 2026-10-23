import { resolveHostDisplay } from '../../../src/shared/host-display-resolution'
import type { PickerOption } from '../components/PickerModal'
import { StatusDot } from '../components/StatusDot'
import { hostEndpointLabel } from '../transport/host-endpoint-label'
import { classifyLegacyHostName } from '../transport/host-name-identity'
import type { HostProfile } from '../transport/types'

/**
 * Rows for "which desktop?" sheets, drawn like Home's desktop rows: the status dot, the name Home
 * shows, and the status line. Every desktop offered is connected, so the dot is green. The endpoint
 * appears only to tell apart two desktops that would otherwise read the same.
 */
export function homeDesktopPickerOptions(hosts: HostProfile[]): PickerOption[] {
  const rows = hosts.map((host) => {
    const identity = classifyLegacyHostName(host)
    const display = resolveHostDisplay({
      name: identity.personalName ?? identity.name,
      machineName: host.lastKnownMachineName ?? null,
      platform: host.lastKnownHostPlatform ?? null
    })
    return { host, display }
  })
  const counts = new Map<string, number>()
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const { host, display } of rows) {
    bump(display.title)
    bump(JSON.stringify([display.title, hostEndpointLabel(host.endpoint)]))
  }
  return rows.map(({ host, display }) => {
    const endpoint = hostEndpointLabel(host.endpoint)
    const titleCollides = (counts.get(display.title) ?? 0) > 1
    const endpointCollides = (counts.get(JSON.stringify([display.title, endpoint])) ?? 0) > 1
    const subtitle = [
      'Connected',
      display.descriptorLine,
      titleCollides ? endpoint : null,
      endpointCollides ? host.id : null
    ]
      .filter(Boolean)
      .join(' · ')
    return {
      value: host.id,
      label: display.title,
      subtitle,
      renderIcon: () => <StatusDot state="connected" size={10} />
    }
  })
}
