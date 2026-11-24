import { useRef, useState } from 'react'
import type { BotUpdateParams } from '../../../../src/shared/rpc-contract/bots-params'
import { BOTS_SLACK_THREAD_REPLIES_RUNTIME_CAPABILITY } from '../../../../src/shared/bot-runtime-capabilities'
import { ListRow } from '../../components/list/ListGroup'
import { MobileSwitch } from '../../components/controls/MobileSwitch'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { useRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import type { PhoneBot } from '../host-bots-operations'

export function MobileSlackThreadReplies(props: {
  bot: PhoneBot
  supported: boolean
  hostName: string
  online: boolean
  save: (updates: BotUpdateParams['updates']) => Promise<boolean>
}) {
  const t = useMobileTranslation()
  const hostSupported = useRouteCapability(BOTS_SLACK_THREAD_REPLIES_RUNTIME_CAPABILITY)
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const mentions = props.bot.slackThreadReplies === 'mentions'
  const label = t('bots.slack.threadReplies.label', 'Only reply when mentioned in threads')
  const supported = hostSupported && props.supported
  const unavailable = !hostSupported
    ? t('bots.slack.threadReplies.updateHost', 'Update Orca on {{host}} to change this option.', {
        host: props.hostName
      })
    : mentions
      ? t(
          'bots.slack.threadReplies.waiting',
          'Your saved choice is not active: this Slack connection does not support it yet.'
        )
      : t(
          'bots.slack.threadReplies.unsupported',
          'This Slack connection does not support this option yet.'
        )

  const change = async (on: boolean): Promise<void> => {
    if (saving.current || !supported || !props.online) {
      return
    }
    saving.current = true
    setBusy(true)
    setFailed(false)
    try {
      setFailed(!(await props.save({ slackThreadReplies: on ? 'mentions' : 'always' })))
    } catch {
      setFailed(true)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      title={t('bots.slack.threadReplies.title', 'Thread replies')}
      footer={[
        t(
          'bots.slack.threadReplies.detail',
          'Applies to this bot in every Slack workspace. DMs always get a reply. When off, replies in joined threads do not need a mention.'
        ),
        !supported ? unavailable : null,
        failed
          ? t('bots.slack.threadReplies.failed', 'Could not save. Try the switch again.')
          : null
      ]
        .filter(Boolean)
        .join('\n\n')}
    >
      <ListRow
        title={label}
        wrapTitle
        accessory={
          <MobileSwitch
            accessibilityLabel={label}
            value={mentions}
            disabled={!supported || !props.online || busy}
            onValueChange={(on) => void change(on)}
          />
        }
      />
    </SettingsSection>
  )
}
