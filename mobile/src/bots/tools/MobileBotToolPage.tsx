// One tool's page: the details the desktop shows when its row opens, what its check found, its
// sign-in from the phone, and Remove (asked first: on a phone it is one stray tap away).
import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { BOT_MCP_APPS } from '../../../../src/shared/bots/bot-mcp-apps'
import type { BotToolProblem } from '../../../../src/shared/bot-tools'
import { botToolSignInFace } from '../../../../src/shared/bots/bot-tool-sign-in-face'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botAgentLabel } from '../mobile-bot-sheet-copy'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { botToolRemove, type PhoneOwnTool } from './bot-tool-operations'
import { MobileBotToolSignInPage } from './MobileBotToolSignInPage'
import {
  botToolAppName,
  botToolSignInActionLabel,
  botToolSignInLine,
  type ToolsBot
} from './bot-tool-words'
import { useBotToolPhoneSignIn } from './use-bot-tool-phone-sign-in'

export function MobileBotToolPage(props: {
  client: RpcClient | null
  bot: ToolsBot
  tool: PhoneOwnTool
  problem: BotToolProblem | undefined
  checking: boolean
  /** Opened from the row's Sign in: the sign-in page shows first. */
  signInFirst: boolean
  hostName: string
  online: boolean
  banner: ReactNode
  onBack: () => void
  /** The tools changed on the host: read them again, and check the servers again with `recheck`. */
  onChanged: (recheck: boolean) => void
  onCheckAgain: () => void
  showToast: (message: string, durationMs?: number) => void
}) {
  const t = useMobileTranslation()
  const { client, bot, tool, problem } = props
  const name = botToolAppName(tool.name)
  const [signingIn, setSigningIn] = useState(props.signInFirst)
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signIn = useBotToolPhoneSignIn({
    client,
    botId: bot.id,
    tool,
    hostName: props.hostName,
    onSignedIn: () => {
      setSigningIn(false)
      // Only the check knows a tool its agent's CLI signs in to is signed in now.
      props.onChanged(tool.signIn === undefined)
      props.showToast(t('bots.tools.signedInTo', 'Signed in to {{app}}', { app: name }))
    }
  })
  const closeSignIn = () => {
    signIn.cancel()
    setSigningIn(false)
  }
  useBackClaim(() => {
    if (removing) {
      setRemoving(false)
    } else if (signingIn) {
      closeSignIn()
    } else {
      props.onBack()
    }
    return true
  })
  const face = botToolSignInFace(
    tool,
    problem,
    signIn.attempt !== null,
    signIn.failure,
    signIn.attempt?.finishing === true
  )
  if (signingIn) {
    return (
      <MobileBotToolSignInPage
        app={name}
        hostName={props.hostName}
        signIn={signIn}
        disabled={!props.online}
        banner={props.banner}
        onClose={closeSignIn}
      />
    )
  }
  if (removing) {
    return (
      <ConfirmContent
        title={t('bots.tools.removeTitle', 'Remove {{app}}?', { app: name })}
        message={t(
          'bots.tools.removeNote',
          '{{bot}} can no longer use {{app}}. You can add it again any time.',
          { bot: bot.name, app: name }
        )}
        confirmLabel={t('bots.tools.remove', 'Remove')}
        destructive
        onCancel={() => setRemoving(false)}
        onConfirm={() => {
          setRemoving(false)
          if (!client) {
            return
          }
          setBusy(true)
          setError(null)
          void botToolRemove
            .request(client, { botId: bot.id, name: tool.name }, { failWhenDisconnected: true })
            .then((response) => {
              botToolRemove.interpret(response)
              props.onChanged(false)
              props.onBack()
            })
            .catch((caught: unknown) => {
              setBusy(false)
              setError(caught instanceof Error ? caught.message : String(caught))
            })
        }}
      />
    )
  }
  const action = botToolSignInActionLabel(face, t)
  const trouble = problem && problem.kind !== 'sign-in' ? problem : undefined
  const agent = botAgentLabel(bot.agent)
  const app = BOT_MCP_APPS.find((entry) => entry.id === tool.name)
  const signInDetail = tool.signIn
    ? t('bots.tools.signInOrca', 'Works with Claude and Codex')
    : tool.remote
      ? problem?.kind === 'sign-in'
        ? t('bots.tools.signInMissing', '{{agent}} isn’t signed in', { agent })
        : t('bots.tools.signInHeld', 'Held by {{agent}}', { agent })
      : null
  const locked = busy || !props.online
  return (
    <>
      <SheetHeader
        title={name}
        subtitle={botToolSignInLine(face, t, props.hostName) ?? undefined}
        onBack={{ label: t('bots.tools.back', 'Back to Tools'), onPress: props.onBack }}
      />
      {props.banner}
      {trouble ? (
        <SettingsSection title={t('bots.tools.problem', 'Problem')} first>
          <ListRow
            title={
              trouble.kind === 'failed'
                ? t('bots.tools.wontStart', 'Won’t start')
                : t('bots.tools.unconfirmed', 'Not confirmed')
            }
            subtitle={trouble.detail}
            subtitleMono
            subtitleLines={8}
            accessory={
              <MobileBotTextButton
                label={t('bots.tools.checkAgain', 'Check again')}
                disabled={locked || props.checking}
                onPress={props.onCheckAgain}
              />
            }
          />
        </SettingsSection>
      ) : null}
      <SettingsSection title={t('bots.tools.details', 'Details')} first={!trouble}>
        {app ? (
          <ListRow key="uses" title={t('bots.tools.uses', 'Uses')} subtitle={app.line} />
        ) : null}
        <ListRow
          key="address"
          title={
            /^https?:\/\//i.test(tool.detail)
              ? t('bots.tools.address', 'Address')
              : t('bots.tools.runs', 'Runs')
          }
          subtitle={tool.detail}
          subtitleMono
          subtitleLines={4}
        />
        <ListRow
          key="people"
          title={t('bots.tools.people', 'People')}
          subtitle={t('bots.tools.peopleNote', 'Anyone who can ask {{bot}} can use it', {
            bot: bot.name
          })}
        />
        {signInDetail ? (
          <ListRow
            key="sign-in"
            title={t('bots.tools.signInLabel', 'Sign-in')}
            subtitle={signInDetail}
          />
        ) : null}
      </SettingsSection>
      <SettingsSection footer={error ? <SettingsNote error>{error}</SettingsNote> : undefined}>
        {face === 'signed-in' ? (
          <ListRow
            key="again"
            title={t('bots.tools.face.signInAgain', 'Sign in again')}
            disabled={locked}
            onPress={() => setSigningIn(true)}
          />
        ) : null}
        <ListRow
          key="remove"
          title={t('bots.tools.removeNamed', 'Remove {{app}}', { app: name })}
          destructive
          disabled={locked}
          onPress={() => setRemoving(true)}
        />
      </SettingsSection>
      {action ? (
        <View style={styles.primary}>
          <SheetPrimaryButton label={action} disabled={locked} onPress={() => setSigningIn(true)} />
        </View>
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  primary: { paddingTop: spacing.xl }
}))
