import { useCommanderHandoffRoute } from './use-commander-handoff-route'
import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import type {
  CommanderAccount,
  CommanderMemoryRevision
} from '../../../src/shared/commander/memory-contract'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { hostStackRouteHref } from '../navigation/host-stack-navigation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { mobileSessionRouteTarget } from '../session/mobile-session-route'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { openCommanderConversation } from './open-commander-conversation'
import { MemoryButton, s } from './phone-memory-controls'

export function ResumeHandoffButton({
  client,
  account,
  page,
  hostId,
  hostScoped
}: {
  client: RpcClient
  account: CommanderAccount
  page: CommanderMemoryRevision
  hostId: string
  hostScoped?: boolean
}) {
  const supportsRoute = useCommanderHandoffRoute()
  const t = useMobileTranslation()
  const handoff = useRouteHandoff()
  const openSession = useOpenMobileSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const flight = useRef<AbortController | null>(null)
  useEffect(() => () => flight.current?.abort(), [client, account, page])
  async function resume() {
    if (flight.current) {
      return
    }
    const request = new AbortController()
    flight.current = request
    setBusy(true)
    setError('')
    try {
      const { sessionId, ...target } = await openCommanderConversation(client, request.signal)
      if (request.signal.aborted) {
        return
      }
      // The destination rechecks sharing, account, revision and the Commander's home session.
      // Only this reference crosses the native/hosted page boundary.
      const goalHandoff = JSON.stringify({
        account,
        pageId: page.pageId,
        version: page.version,
        sessionId
      })
      const route = { hostId, ...target, goalHandoff }
      if (hostScoped) {
        handoff.push(hostStackRouteHref(mobileSessionRouteTarget(route)))
      } else {
        openSession({ ...route, standalone: true })
      }
    } catch (err) {
      if (!request.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      flight.current = null
      if (!request.signal.aborted) {
        setBusy(false)
      }
    }
  }
  if (!supportsRoute) {
    return (
      <Text selectable style={s.meta}>
        {t(
          'commander.handoffUpdatePhone',
          'Update the Orca app on your phone to resume this handoff in chat.'
        )}
      </Text>
    )
  }
  return (
    <View style={s.stack}>
      <MemoryButton
        primary
        disabled={busy}
        label={
          busy
            ? t('commander.chatOpening', 'Opening chat…')
            : t('commander.handoffResume', 'Resume in Commander')
        }
        onPress={() => void resume()}
      />
      <Text style={s.meta}>
        {t('commander.handoffHint', 'Review the draft in Commander chat before sending.')}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={s.meta}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}
