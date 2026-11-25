// Settings' Schedule: the Look around and Memory upkeep rows, for an agent that can run them, and their pages.
import { useState, type ReactNode } from 'react'
import {
  botLookAround,
  lookAroundSupported,
  type BotLookAround
} from '../../../src/shared/bots/bot-look-around'
import { botTidyUp, type BotTidyUp } from '../../../src/shared/bots/bot-tidy-up'
import type { BotUpdateParams } from '../../../src/shared/rpc-contract/bots-params'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { DrillRow } from '../host-screen/workspace-options/workspace-option-rows'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { lookAroundLine, tidyUpLine } from './bot-settings-lines'
import type { SettingsFeature, SettingsRootPage } from './MobileBotSettingsRoot'
import {
  MobileLookAroundPage,
  MobileLookAroundSection,
  type LookAroundPage
} from './MobileBotLookAround'
import { MobileTidyUpPage, MobileTidyUpSection, type TidyUpPage } from './MobileBotTidyUp'
import { useMobileBotTidyUp } from './use-mobile-bot-tidy-up'
import type { RouteBot } from './use-route-bot'

export function useBotScheduleSettings(
  settings: {
    client: RpcClient | null
    routeBot: RouteBot
    showToast: (message: string, durationMs?: number) => void
    /** Look now, for an agent that looks around. */
    upNext: { lookNow: () => void; busy: boolean }
    online: boolean
  },
  context: {
    banner: ReactNode
    /** A save is in flight, or the host is offline. */
    locked: boolean
    page: SettingsRootPage | null
    setPage: (page: SettingsRootPage | null) => void
    save: (updates: BotUpdateParams['updates']) => Promise<boolean>
  }
): SettingsFeature {
  const t = useMobileTranslation()
  const { bot, reads, activity } = settings.routeBot
  const { banner, locked, page, setPage, save } = context
  // A page drilled into from Look around or Memory upkeep; its Back returns there.
  const [lookPage, setLookPage] = useState<LookAroundPage | null>(null)
  const [tidyPage, setTidyPage] = useState<TidyUpPage | null>(null)
  const ours = page === 'look-around' || page === 'tidy-up'
  // A drilled-into page claims Back itself.
  useBackClaim(
    ours && !lookPage && !tidyPage
      ? () => {
          setPage(null)
          return true
        }
      : null
  )
  const tidyUp = useMobileBotTidyUp(settings.client, bot.id, reads, settings.showToast)
  const lookAround = lookAroundSupported(bot.agent) ? settings.upNext : null
  if (!lookAround) {
    return { rows: [], page: null }
  }
  const saveLookAround = (change: Partial<BotLookAround>) => void save({ lookAround: change })
  const saveTidyUp = (change: Partial<BotTidyUp>) => void save({ tidyUp: change })
  const backToSettings = {
    label: t('bots.lookAround.back', 'Back to Settings'),
    onPress: () => setPage(null)
  }
  const rows: SettingsFeature['rows'] = [
    {
      key: 'look-around',
      group: 'schedule',
      node: (
        <DrillRow
          label={t('bots.lookAround.title', 'Look around')}
          value={lookAroundLine(botLookAround(bot), activity?.upNext?.state.lastLookedAt)}
          detail
          onPress={() => setPage('look-around')}
        />
      )
    },
    {
      key: 'tidy-up',
      group: 'schedule',
      node: (
        <DrillRow
          label={t('bots.tidyUp.title', 'Memory upkeep')}
          value={tidyUpLine(botTidyUp(bot), tidyUp.view?.last?.at)}
          detail
          onPress={() => setPage('tidy-up')}
        />
      )
    }
  ]
  if (page === 'tidy-up') {
    return {
      rows,
      page: tidyPage ? (
        <MobileTidyUpPage
          page={tidyPage}
          bot={bot}
          view={tidyUp.view}
          busy={tidyUp.busy}
          disabled={!settings.online}
          banner={banner}
          save={saveTidyUp}
          onUndo={tidyUp.undo}
          onBack={() => setTidyPage(null)}
        />
      ) : (
        <>
          <SheetHeader title={t('bots.tidyUp.title', 'Memory upkeep')} onBack={backToSettings} />
          {banner}
          <MobileTidyUpSection
            bot={bot}
            view={tidyUp.view}
            disabled={locked || tidyUp.busy}
            save={saveTidyUp}
            onOpen={setTidyPage}
            onTidyNow={tidyUp.tidyNow}
          />
        </>
      )
    }
  }
  if (page === 'look-around') {
    return {
      rows,
      page: lookPage ? (
        <MobileLookAroundPage
          page={lookPage}
          bot={bot}
          save={saveLookAround}
          onBack={() => setLookPage(null)}
          disabled={!settings.online}
          banner={banner}
        />
      ) : (
        <>
          <SheetHeader title={t('bots.lookAround.title', 'Look around')} onBack={backToSettings} />
          {banner}
          <MobileLookAroundSection
            bot={bot}
            upNext={activity?.upNext}
            disabled={locked || lookAround.busy}
            save={saveLookAround}
            onOpen={setLookPage}
            onLookNow={lookAround.lookNow}
          />
        </>
      )
    }
  }
  return { rows, page: null }
}
