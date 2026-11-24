import { Text } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { s } from './phone-memory-controls'
import type { PhonePageSummary } from './phone-memory-rpc'
export function PhoneMemoryAttribution({ page }: { page: PhonePageSummary }) {
  const t = useMobileTranslation()
  const actor =
    page.actor.type === 'human'
      ? t('commander.memoryHuman', 'Human')
      : page.actor.type === 'commander'
        ? t('commander.memoryCommander', 'Commander')
        : t('commander.memoryAgent', 'Agent')
  return (
    <Text selectable style={s.meta}>
      {[
        actor + ' · ' + page.actor.id,
        'v' + page.version,
        new Date(page.createdAt).toLocaleString()
      ].join(' · ')}
    </Text>
  )
}
