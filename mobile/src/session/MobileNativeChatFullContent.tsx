import { useContext, useEffect, useMemo, useState } from 'react'
import { Pressable, Text, View, type TextStyle } from 'react-native'
import { truncateToolDetail } from '../../../src/shared/native-chat/tools/native-chat-tool-summary'
import {
  isNativeChatToolOutputClipped,
  nativeChatToolFullPayload,
  nativeChatToolOutputPartialSizes
} from '../../../src/shared/native-chat/tools/native-chat-tool-output'
import type {
  NativeChatMessage,
  NativeChatToolResultBlock
} from '../../../src/shared/native-chat-types'
import type { AgentJournalBoundedPayload } from '../../../src/shared/agent-session-journal-types'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { styles } from './native-chat/transcript/mobile-native-chat-message-styles'
import { toolStyles } from './native-chat/transcript/mobile-native-chat-tool-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileNativeChatOwnedScrollView } from './MobileNativeChatOwnedScrollView'
import {
  MobileNativeChatItemSourceContext,
  readMobileNativeChatItem
} from './mobile-native-chat-item-read'

// Keep full-content state per row so live transcript revisions cannot overwrite the reader’s requested expansion.

type Load = 'idle' | 'loading' | 'failed'

function ShowFull({
  label,
  failedLabel,
  load,
  onPress
}: {
  label: string
  failedLabel: string
  load: Load
  onPress: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  return (
    <Pressable
      style={styles.showFull}
      onPress={onPress}
      disabled={load === 'loading'}
      hitSlop={8}
      accessibilityRole="button"
    >
      <Text style={styles.showFullText}>{load === 'failed' ? failedLabel : label}</Text>
    </Pressable>
  )
}

export function MobileNativeChatToolOutput({
  body,
  type,
  rootIdentity,
  positionKey
}: {
  body: NativeChatToolResultBlock
  type: TextStyle
  rootIdentity: string
  positionKey: string
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const source = useContext(MobileNativeChatItemSourceContext)
  const { output, isError, fullOutputItemId } = body
  const client = source?.client,
    sessionId = source?.sessionId
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<{
    body: typeof body
    client: typeof client
    sessionId: typeof sessionId
    full?: AgentJournalBoundedPayload
    load: Load
  } | null>(null)
  useEffect(
    () => () =>
      setDetail((held) =>
        held?.body === body && held.client === client && held.sessionId === sessionId ? null : held
      ),
    [body, client, sessionId]
  )
  const current =
    detail?.body === body && detail.client === client && detail.sessionId === sessionId
      ? detail
      : null
  const full = current?.full
  const clipped = isNativeChatToolOutputClipped(body, { expanded, fullLoaded: Boolean(full) })
  const partial = useMemo(() => (full ? nativeChatToolOutputPartialSizes(full) : null), [full])
  const showFull = (): void => {
    if (fullOutputItemId === undefined || source === null) {
      setExpanded(true)
      return
    }
    setDetail({ body, client, sessionId, load: 'loading' })
    const finish = (full?: AgentJournalBoundedPayload): void => {
      setDetail((held) =>
        held?.body === body && held.client === client && held.sessionId === sessionId
          ? { body, client, sessionId, full, load: full ? 'idle' : 'failed' }
          : held
      )
    }
    readMobileNativeChatItem(source, fullOutputItemId)
      .then((item) =>
        finish(
          item?.itemId === fullOutputItemId
            ? (nativeChatToolFullPayload(item.body) ?? undefined)
            : undefined
        )
      )
      .catch(() => finish())
  }
  return (
    <View>
      <MobileNativeChatOwnedScrollView
        rootIdentity={rootIdentity}
        positionKey={positionKey}
        style={[toolStyles.codeBox, toolStyles.codeScroll]}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      >
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[toolStyles.codeText, type, isError && toolStyles.errorText]}
        >
          {full ? full.head : expanded ? output : truncateToolDetail(output)}
        </Text>
      </MobileNativeChatOwnedScrollView>
      {partial ? (
        <Text style={styles.showFullText}>
          {t('session.nativeChatFullContent.partialOutput', 'Showing {{shown}} of {{total}}.', {
            shown: partial.shown,
            total: partial.total
          })}
        </Text>
      ) : null}
      {clipped ? (
        <ShowFull
          label={t('session.nativeChatFullContent.showFullOutput', 'Show full output')}
          failedLabel={t(
            'session.nativeChatFullContent.loadOutputFailed',
            "Show full output — couldn't load, tap to retry"
          )}
          load={current?.load ?? 'idle'}
          onPress={showFull}
        />
      ) : null}
    </View>
  )
}

export function useMobileNativeChatFullMessage(message: NativeChatMessage): {
  shown: NativeChatMessage
  showFull: React.JSX.Element | null
  recovery: { load: Load; onPress: () => void } | null
} {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const source = useContext(MobileNativeChatItemSourceContext)
  const detail = source?.messageDetail
  const client = source?.client,
    sessionId = source?.sessionId
  const raw = detail?.raw(message.id)
  const [request, setRequest] = useState<{
    raw: typeof raw
    client: typeof client
    sessionId: typeof sessionId
    load: Load
  } | null>(null)
  const load =
    request?.raw === raw && request?.client === client && request?.sessionId === sessionId
      ? (request?.load ?? 'idle')
      : 'idle'
  const state = detail?.state(message.id)
  const showFull = (): void => {
    setRequest({ raw, client, sessionId, load: 'loading' })
    const finish = (load: Load): void =>
      setRequest((held) =>
        held?.raw === raw && held?.client === client && held?.sessionId === sessionId
          ? { raw, client, sessionId, load }
          : held
      )
    void detail
      ?.load(message.id)
      .then(() => finish('idle'))
      .catch(() => finish('failed'))
  }
  return {
    shown: message,
    recovery: state === 'available' ? { load, onPress: showFull } : null,
    showFull:
      state === 'partial' ? (
        <Text style={styles.showFullText}>
          {t('session.nativeChatFullContent.partialMessage', 'Showing part of this message.')}
        </Text>
      ) : state === 'available' ? (
        <ShowFull
          label={t('session.nativeChatFullContent.showFullMessage', 'Show full message')}
          failedLabel={t(
            'session.nativeChatFullContent.loadMessageFailed',
            "Show full message — couldn't load, tap to retry"
          )}
          load={load}
          onPress={showFull}
        />
      ) : null
  }
}
