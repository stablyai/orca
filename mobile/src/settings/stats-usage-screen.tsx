import { useRouter } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { StatsUsagePanel } from '../stats/StatsUsagePanel'
import { SettingsScreen } from './settings-screen-frame'

export default function StatsUsageScreen(props: { client: RpcClient | null; onBack?: () => void }) {
  const t = useMobileTranslation()
  const router = useRouter()
  return (
    <SettingsScreen
      title={t('statsUsage.title', 'Stats & Usage')}
      onBack={props.onBack ?? (() => router.back())}
    >
      <StatsUsagePanel client={props.client} />
    </SettingsScreen>
  )
}
