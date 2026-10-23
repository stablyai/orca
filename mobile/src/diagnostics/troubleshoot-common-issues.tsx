import { WifiOff, Shield, Monitor, Clock, Globe, Bell, type LucideIcon } from 'lucide-react-native'

export type TroubleshootSection = {
  id: string
  icon: LucideIcon
  title: string
  steps: string[]
}

export const troubleshootCommonIssues: TroubleshootSection[] = [
  {
    id: 'notifications',
    icon: Bell,
    title: 'Push notifications',
    steps: [
      'Check that system settings allow Orca notifications and that Focus or Do Not Disturb is off.',
      'Try cellular or another Wi-Fi network. If alerts arrive after switching, your network may be delaying delivery.'
    ]
  },
  {
    id: 'wifi',
    icon: WifiOff,
    title: 'Different Wi-Fi networks',
    steps: [
      'Both devices must be on the same local network, unless they connect through Tailscale.',
      'Ethernet and Wi-Fi must share the same subnet.',
      'Try reconnecting Wi-Fi on both devices.'
    ]
  },
  {
    id: 'firewall',
    icon: Shield,
    title: 'Firewall blocking port 6768',
    steps: [
      'macOS: System Settings → Network → Firewall, then allow Orca.',
      'Windows: Defender Firewall → Allow an app, then enable Orca for private networks.',
      'Linux: sudo ufw allow 6768',
      'Corporate and school networks may block direct connections. Try a personal hotspot.'
    ]
  },
  {
    id: 'desktop',
    icon: Monitor,
    title: 'Orca not running on the desktop',
    steps: [
      'Orca must be open on your desktop to accept connections.',
      'Try restarting Orca. The companion server starts on launch.',
      'After an update, you may need to pair again with the QR code.'
    ]
  },
  {
    id: 'timeout',
    icon: Clock,
    title: 'Connection timeout',
    steps: [
      'Check the Wi-Fi signal strength on your phone.',
      'Go back to your desktops and tap the desktop to retry.',
      'Restart both apps if timeouts persist.'
    ]
  },
  {
    id: 'tailscale',
    icon: Globe,
    title: 'Tailscale desktop unreachable',
    steps: [
      'Addresses like 100.x.x.x or *.ts.net connect through Tailscale, so keep it on.',
      'iOS and Android can silently stall the tunnel. Turn Tailscale off and back on in the Tailscale app.',
      'Check that the desktop is awake and shows as connected in your tailnet.',
      'Update the Tailscale app. Recent releases fix reconnect bugs.'
    ]
  },
  {
    id: 'vpn',
    icon: Shield,
    title: 'Other VPN interference',
    steps: [
      'VPNs other than Tailscale can route local traffic through a remote server.',
      'Turn that VPN off, or turn on split tunneling or "Allow LAN".'
    ]
  }
]
