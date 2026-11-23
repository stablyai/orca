import { memo, useMemo } from 'react'
import { botsOfflineWord } from '../../bots/host-bot-listing'
import { botHomeWorktreeId } from '../../bots/host-bots-read'
import { mobileBotRowLimitText } from '../../bots/mobile-bot-row-line'
import { useMobileBotUsageLimitStop } from '../../bots/use-mobile-bot-usage-limit-stop'
import { useSharedNowSnapshot } from '../../hooks/use-now'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host/execution-host'
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

const keepNow = (now: number): number => now
const noClock = (): number => 0

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
  // A kept row (no dot) isn't live, and a server's sessions aren't on its paired computer's feed.
  const live =
    row.kind === 'bot' && row.dot !== null && row.executionHost === LOCAL_EXECUTION_HOST_ID
  // Only a live row's stop can end, so only it redraws on the clock.
  const now = useSharedNowSnapshot(60_000, live ? keepNow : noClock)
  const homeId = row.kind === 'bot' ? botHomeWorktreeId(row.bot) : null
  const workspaceIds = useMemo(() => (homeId ? [homeId] : []), [homeId])
  const stop = useMobileBotUsageLimitStop(live ? row.pairedHostId : null, workspaceIds, now)
  const limitText =
    row.kind === 'bot'
      ? mobileBotRowLimitText(stop, row.line, {
          dot: row.dot,
          chatSessionId: row.bot.chatSessionId
        })
      : null
  return (
    <MobileBotRowView
      avatar={
        row.kind === 'bot' ? (
          <MobileBotRowAvatar
            avatar={mobileBotAvatarSource(row.bot)}
            dot={row.dot}
            stopped={limitText !== null}
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
      preview={limitText ?? row.preview}
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
