import { useEffect, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ListRow } from '../src/components/list/ListGroup'
import { loadHostCatalog } from '../src/host-catalog/host-store'
import { troubleshootCommonIssues } from '../src/diagnostics/troubleshoot-common-issues'
import { firstParam } from '../src/navigation/route-param-reader'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import { SettingsScreen, SettingsSection } from '../src/settings/settings-screen-frame'

/** One common issue from Troubleshooting: its steps, numbered, in one group. */
export default function TroubleshootIssueScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const id = firstParam(useLocalSearchParams<{ id?: string }>().id)
  // The firewall issue names each paired computer's port, as the list it came from does.
  const [endpoints, setEndpoints] = useState<string[]>([])
  useEffect(() => {
    void loadHostCatalog().then(
      (hosts) => setEndpoints(hosts.map((host) => host.endpoint)),
      () => {}
    )
  }, [])
  const issue = troubleshootCommonIssues(t, endpoints).find((entry) => entry.id === id)
  return (
    <SettingsScreen
      title={issue?.title ?? t('diagnostics.troubleshootView.commonIssues', 'Common issues')}
      onBack={() => router.back()}
    >
      {issue ? (
        <SettingsSection first>
          {issue.steps.map((step, index) => (
            <ListRow key={step} marker={String(index + 1)} title={step} wrapTitle />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsScreen>
  )
}
