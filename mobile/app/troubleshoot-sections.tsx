import { WifiOff, Shield, Monitor, Clock, Globe } from 'lucide-react-native'
import { colors } from '../src/theme/mobile-theme'

export type TroubleshootSection = {
  id: string
  icon: React.ReactNode
  title: string
  steps: string[]
}

export type TranslateFn = (
  key: string,
  fallback: string,
  options?: Record<string, unknown>
) => string

export function buildTroubleshootSections(t: TranslateFn): TroubleshootSection[] {
  return [
    {
      id: 'wifi',
      icon: <WifiOff size={16} color={colors.textSecondary} />,
      title: t('mobile.troubleshoot.wifiNetworks', 'Different WiFi Networks'),
      steps: [
        t('mobile.troubleshoot.wifiStep1', 'Both devices must be on the same local network.'),
        t('mobile.troubleshoot.wifiStep2', 'Ethernet and WiFi must share the same subnet.'),
        t('mobile.troubleshoot.wifiStep3', 'Try reconnecting WiFi on both devices.')
      ]
    },
    {
      id: 'firewall',
      icon: <Shield size={16} color={colors.textSecondary} />,
      title: t('mobile.troubleshoot.firewall', 'Firewall Blocking Port 6768'),
      steps: [
        t(
          'mobile.troubleshoot.firewallStep1',
          'macOS: System Settings → Network → Firewall — allow Orca.'
        ),
        t(
          'mobile.troubleshoot.firewallStep2',
          'Windows: Defender Firewall → Allow app — enable Orca for Private networks.'
        ),
        t('mobile.troubleshoot.firewallStep3', 'Linux: sudo ufw allow 6768'),
        t(
          'mobile.troubleshoot.firewallStep4',
          'Corporate/school networks may block P2P — try a personal hotspot.'
        )
      ]
    },
    {
      id: 'desktop',
      icon: <Monitor size={16} color={colors.textSecondary} />,
      title: t('mobile.troubleshoot.desktopApp', 'Desktop App Not Running'),
      steps: [
        t(
          'mobile.troubleshoot.desktopStep1',
          'Orca must be open on your desktop to accept connections.'
        ),
        t(
          'mobile.troubleshoot.desktopStep2',
          'Try restarting Orca — the companion server starts on launch.'
        ),
        t(
          'mobile.troubleshoot.desktopStep3',
          'After an update, you may need to re-pair via QR code.'
        )
      ]
    },
    {
      id: 'timeout',
      icon: <Clock size={16} color={colors.textSecondary} />,
      title: t('mobile.troubleshoot.timeout', 'Connection Timeout'),
      steps: [
        t('mobile.troubleshoot.timeoutStep1', 'Check WiFi signal strength on your phone.'),
        t(
          'mobile.troubleshoot.timeoutStep2',
          'Go back to the host list and tap your host to retry.'
        ),
        t('mobile.troubleshoot.timeoutStep3', 'Restart both apps if timeouts persist.')
      ]
    },
    {
      id: 'vpn',
      icon: <Globe size={16} color={colors.textSecondary} />,
      title: t('mobile.troubleshoot.vpn', 'VPN Interference'),
      steps: [
        t('mobile.troubleshoot.vpnStep1', 'VPNs can route local traffic through a remote server.'),
        t(
          'mobile.troubleshoot.vpnStep2',
          'Disable the VPN or enable split tunneling / "Allow LAN".'
        )
      ]
    }
  ]
}
