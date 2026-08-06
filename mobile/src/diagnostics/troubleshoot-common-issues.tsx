import { WifiOff, Shield, Monitor, Clock, Globe } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { t } from '@/i18n/mobile-i18n'

export type TroubleshootSection = {
  id: string
  icon: React.ReactNode
  title: string
  instructions: string[]
}

export function getTroubleshootCommonIssues(): TroubleshootSection[] {
  return [
    {
      id: 'wifi',
      icon: <WifiOff size={16} color={colors.textSecondary} />,
      title: t('troubleshootCommonIssues.different'),
      instructions: [
        t('troubleshootCommonIssues.both'),
        t('troubleshootCommonIssues.ethernet'),
        t('troubleshootCommonIssues.tryReconnecting')
      ]
    },
    {
      id: 'firewall',
      icon: <Shield size={16} color={colors.textSecondary} />,
      title: t('troubleshootCommonIssues.firewall'),
      instructions: [
        t('troubleshootCommonIssues.mac'),
        t('troubleshootCommonIssues.windows'),
        t('troubleshootCommonIssues.linux'),
        t('troubleshootCommonIssues.corporate')
      ]
    },
    {
      id: 'desktop',
      icon: <Monitor size={16} color={colors.textSecondary} />,
      title: t('troubleshootCommonIssues.desktop'),
      instructions: [
        t('troubleshootCommonIssues.orca'),
        t('troubleshootCommonIssues.tryRestarting'),
        t('troubleshootCommonIssues.after')
      ]
    },
    {
      id: 'timeout',
      icon: <Clock size={16} color={colors.textSecondary} />,
      title: t('troubleshootCommonIssues.connection'),
      instructions: [
        t('troubleshootCommonIssues.checkWi'),
        t('troubleshootCommonIssues.go'),
        t('troubleshootCommonIssues.restart')
      ]
    },
    {
      id: 'tailscale',
      icon: <Globe size={16} color={colors.textSecondary} />,
      title: t('troubleshootCommonIssues.tailscale'),
      instructions: [
        t('troubleshootCommonIssues.host'),
        t('troubleshootCommonIssues.i'),
        t('troubleshootCommonIssues.checkDesktop'),
        t('troubleshootCommonIssues.update')
      ]
    },
    {
      id: 'vpn',
      icon: <Shield size={16} color={colors.textSecondary} />,
      title: t('troubleshootCommonIssues.other'),
      instructions: [t('troubleshootCommonIssues.non'), t('troubleshootCommonIssues.disable')]
    }
  ]
}
