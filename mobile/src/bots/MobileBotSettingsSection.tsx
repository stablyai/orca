import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { ListGroup, SectionHeader } from '../components/list/ListGroup'
import { optionStyles } from './mobile-bot-option-styles'

export function MobileBotSettingsSection({
  title,
  detail,
  children
}: {
  title: string
  detail?: string
  children: ReactNode
}) {
  return (
    <View>
      <SectionHeader title={title} />
      {detail ? (
        <Text style={[optionStyles.optionRowDetail, optionStyles.optionPageTitle]}>{detail}</Text>
      ) : null}
      <ListGroup>{children}</ListGroup>
    </View>
  )
}
