import { memo } from 'react'
import { botsOfflineWord } from '../../bots/host-bot-listing'
import { mobileBotAvatarSource } from '../../bots/host-bot-row-facts'
import { MobileBotFaceStack } from '../../bots/MobileBotFaceStack'
import {
  MobileBotNeedsYouCount,
  MobileBotRowAvatar,
  MobileBotRowStatus,
  MobileBotRowView
} from '../../bots/MobileBotHomeRow'
import { HostContextPill } from '../../worktree/row-presentation/HostContextPill'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { HomeBotRow } from './home-bot-rows'

/** A bot or room on Home: the computer's Bots row, always naming where it runs. */
export const MobileHomeBotRow = memo(function MobileHomeBotRow(props: {
  row: HomeBotRow
  divider: boolean
  /** It sits on Feed's grouped panel, which its status ring matches. */
  grouped?: boolean
  onOpen: (row: HomeBotRow) => void
}) {
  useMobileColorScheme()
  const { row } = props
  const surface = props.grouped ? colors.bgPanel : undefined
  return (
    <MobileBotRowView
      avatar={
        row.kind === 'bot' ? (
          <MobileBotRowAvatar
            avatar={mobileBotAvatarSource(row.bot)}
            dot={row.dot}
            surface={surface}
          />
        ) : (
          <>
            <MobileBotFaceStack faces={row.faces} />
            <MobileBotRowStatus dot={row.dot} surface={surface} />
          </>
        )
      }
      title={row.title}
      unread={row.unread}
      preview={row.preview}
      previewLeading={
        <HostContextPill
          hostId={row.executionHost}
          label={row.hostLabel}
          healthLabel={row.offline ? botsOfflineWord() : undefined}
        />
      }
      age={row.age}
      dimmed={row.offline === true || (row.kind === 'bot' && row.bot.paused)}
      divider={props.divider}
      onPress={() => props.onOpen(row)}
      titleTrailing={row.needsYou > 0 ? <MobileBotNeedsYouCount count={row.needsYou} /> : null}
    />
  )
})

/** Home's bot rows, kept from redrawing while their list is unchanged. */
export const MobileHomeBotRows = memo(function MobileHomeBotRows(props: {
  rows: readonly HomeBotRow[]
  grouped?: boolean
  onOpen: (row: HomeBotRow) => void
}) {
  useMobileColorScheme()
  return props.rows.map((row, index) => (
    <MobileHomeBotRow
      key={row.key}
      row={row}
      divider={index > 0}
      grouped={props.grouped}
      onOpen={props.onOpen}
    />
  ))
})
