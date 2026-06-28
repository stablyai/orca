// Why: kept out of troubleshoot.tsx to keep the screen file under the
// project max-lines rule. Static fixture data; icon JSX is built inline so
// the data file does not depend on React Native component imports.
import { Clock, Globe, Monitor, Shield, WifiOff } from 'lucide-react-native'
import { colors } from '../src/theme/mobile-theme'

export type TroubleshootSection = {
  id: string
  icon: React.ReactNode
  title: string
  steps: string[]
}

export const sections: TroubleshootSection[] = [
  {
    id: 'wifi',
    icon: <WifiOff size={16} color={colors.textSecondary} />,
    title: 'Different WiFi Networks',
    steps: [
      'Both devices must be on the same local network.',
      'Ethernet and WiFi must share the same subnet.',
      'Try reconnecting WiFi on both devices.'
    ]
  },
  {
    id: 'firewall',
    icon: <Shield size={16} color={colors.textSecondary} />,
    title: 'Firewall Blocking Port 6768',
    steps: [
      'macOS: System Settings → Network → Firewall — allow Orca.',
      'Windows: Defender Firewall → Allow app — enable Orca for Private networks.',
      'Linux: sudo ufw allow 6768',
      'Corporate/school networks may block P2P — try a personal hotspot.'
    ]
  },
  {
    id: 'desktop',
    icon: <Monitor size={16} color={colors.textSecondary} />,
    title: 'Desktop App Not Running',
    steps: [
      'Orca must be open on your desktop to accept connections.',
      'Try restarting Orca — the companion server starts on launch.',
      'After an update, you may need to re-pair via QR code.'
    ]
  },
  {
    id: 'timeout',
    icon: <Clock size={16} color={colors.textSecondary} />,
    title: 'Connection Timeout',
    steps: [
      'Check WiFi signal strength on your phone.',
      'Go back to the host list and tap your host to retry.',
      'Restart both apps if timeouts persist.'
    ]
  },
  {
    id: 'vpn',
    icon: <Globe size={16} color={colors.textSecondary} />,
    title: 'VPN Interference',
    steps: [
      'VPNs can route local traffic through a remote server.',
      'Disable the VPN or enable split tunneling / "Allow LAN".'
    ]
  }
]
