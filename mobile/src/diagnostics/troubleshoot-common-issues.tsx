import { WifiOff, Shield, Monitor, Clock, Globe } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { t } from '@/i18n/mobile-i18n'

export type TroubleshootSection = {
  id: string
  icon: React.ReactNode
  title: string
  instructions: string[]
}

export const troubleshootCommonIssues: TroubleshootSection[] = [
  {
    id: 'wifi',
    icon: <WifiOff size={16} color={colors.textSecondary} />,
    title: t('m.vuZn-_E'),
    instructions: [t('m.DFWK1QU'), t('m.h6u3Ajc'), t('m.jEL8NQc')]
  },
  {
    id: 'firewall',
    icon: <Shield size={16} color={colors.textSecondary} />,
    title: t('m.amY3iCs'),
    instructions: [t('m.REilmMs'), t('m.ayekp1A'), t('m.401zg0M'), t('m.rtC8ngI')]
  },
  {
    id: 'desktop',
    icon: <Monitor size={16} color={colors.textSecondary} />,
    title: t('m.MED_8yU'),
    instructions: [t('m.i4fV_jk'), t('m.WkJ-I-g'), t('m.neP0TKg')]
  },
  {
    id: 'timeout',
    icon: <Clock size={16} color={colors.textSecondary} />,
    title: t('m.AE3mc7A'),
    instructions: [t('m.uGWzUrE'), t('m.gvS1F3o'), t('m.S9tNuKw')]
  },
  {
    id: 'tailscale',
    icon: <Globe size={16} color={colors.textSecondary} />,
    title: t('m.ngjn4tY'),
    instructions: [t('m.T6EL0oM'), t('m.rmMn9Xc'), t('m.j0KeldQ'), t('m.PxeuBQc')]
  },
  {
    id: 'vpn',
    icon: <Shield size={16} color={colors.textSecondary} />,
    title: t('m.jLhPXXQ'),
    instructions: [t('m.n-WXtiA'), t('m.MJ1SglY')]
  }
]
