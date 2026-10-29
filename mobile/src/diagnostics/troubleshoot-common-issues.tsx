import { WifiOff, Shield, Monitor, Clock, Globe, Bell, type LucideIcon } from 'lucide-react-native'
import type { Translate } from '../i18n/mobile-i18n'

export type TroubleshootSection = {
  id: string
  icon: LucideIcon
  title: string
  steps: string[]
}

export function troubleshootCommonIssues(t: Translate): TroubleshootSection[] {
  return [
    {
      id: 'notifications',
      icon: Bell,
      title: t('diagnostics.troubleshootCommonIssues.notificationsTitle', 'Push Notifications'),
      steps: [
        t(
          'diagnostics.troubleshootCommonIssues.allowNotifications',
          'Check that system settings allow Orca notifications and that Focus or Do Not Disturb is off.'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.notificationNetwork',
          'Try cellular or another Wi-Fi network. If alerts arrive after switching, your network may be delaying delivery.'
        )
      ]
    },

    {
      id: 'wifi',
      icon: WifiOff,
      title: t('diagnostics.troubleshootCommonIssues.wifiTitle', 'Different WiFi Networks'),
      steps: [
        t(
          'diagnostics.troubleshootCommonIssues.sameNetwork',
          'Both devices must be on the same LAN (unless connected through Tailscale).'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.sameSubnet',
          'Ethernet and WiFi must share the same subnet.'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.reconnectWifi',
          'Try reconnecting WiFi on both devices.'
        )
      ]
    },
    {
      id: 'firewall',
      icon: Shield,
      title: t('diagnostics.troubleshootCommonIssues.firewallTitle', 'Firewall Blocking Port 6768'),
      steps: [
        t(
          'diagnostics.troubleshootCommonIssues.macosFirewall',
          'macOS: System Settings → Network → Firewall — allow Orca.'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.windowsFirewall',
          'Windows: Defender Firewall → Allow app — enable Orca for Private networks.'
        ),
        'Linux: sudo ufw allow 6768',
        t(
          'diagnostics.troubleshootCommonIssues.restrictedNetwork',
          'Corporate/school networks may block P2P — try a personal hotspot.'
        )
      ]
    },
    {
      id: 'desktop',
      icon: Monitor,
      title: t('diagnostics.troubleshootCommonIssues.desktopTitle', 'Desktop App Not Running'),
      steps: [
        t(
          'diagnostics.troubleshootCommonIssues.openDesktop',
          'Orca must be open on your desktop to accept connections.'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.restartDesktop',
          'Try restarting Orca — the companion server starts on launch.'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.pairAfterUpdate',
          'After an update, you may need to re-pair via QR code.'
        )
      ]
    },
    {
      id: 'timeout',
      icon: Clock,
      title: t('diagnostics.troubleshootCommonIssues.timeoutTitle', 'Connection Timeout'),
      steps: [
        t(
          'diagnostics.troubleshootCommonIssues.wifiSignal',
          'Check WiFi signal strength on your phone.'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.retryHost',
          'Go back to the host list and tap your host to retry.'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.restartBothApps',
          'Restart both apps if timeouts persist.'
        )
      ]
    },
    {
      id: 'tailscale',
      icon: Globe,
      title: t('diagnostics.troubleshootCommonIssues.tailscaleTitle', 'Tailscale Host Unreachable'),
      steps: [
        t(
          'diagnostics.troubleshootCommonIssues.keepTailscaleOn',
          'Host addresses like 100.x.x.x or *.ts.net connect through Tailscale — keep it ON.'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.restartTailscale',
          'iOS/Android can silently wedge the tunnel: toggle Tailscale off and back on in the Tailscale app.'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.checkTailnet',
          'Check the desktop is awake and shows as connected in your tailnet.'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.updateTailscale',
          'Update the Tailscale app — recent releases fix reconnect bugs.'
        )
      ]
    },
    {
      id: 'vpn',
      icon: Shield,
      title: t('diagnostics.troubleshootCommonIssues.vpnTitle', 'Other VPN Interference'),
      steps: [
        t(
          'diagnostics.troubleshootCommonIssues.vpnRouting',
          'Non-Tailscale VPNs can route local traffic through a remote server.'
        ),
        t(
          'diagnostics.troubleshootCommonIssues.disableVpn',
          'Disable that VPN or enable split tunneling / "Allow LAN".'
        )
      ]
    }
  ]
}
