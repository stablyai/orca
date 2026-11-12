import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type {
  ReadSnapshotMessage,
  ReadSnapshotSession
} from '../../../src/shared/cloud-workspaces/read-snapshot'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileNativeChatMarkdown } from '../session/native-chat/transcript/MobileNativeChatMarkdown'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { cloudAgentLabel } from './CloudAgentPicker'
import { readSnapshotStyles as styles } from './cloud-read-snapshot-styles'
import { cloudWorkspaceScreenStyles as screen } from './cloud-workspace-screen-styles'

export function readSnapshotSessionStatus(
  session: Pick<ReadSnapshotSession, 'status' | 'turnOutcome'>,
  t: Translate
): string | null {
  switch (session.status) {
    case 'working':
      return t('cloud.snapshot.status.working', 'Working')
    case 'attention':
      return t('cloud.snapshot.status.attention', 'Needs you')
    case 'idle':
      return session.turnOutcome
        ? t('cloud.snapshot.status.done', 'Done')
        : t('cloud.snapshot.status.idle', 'Idle')
    case 'unknown':
      return null
  }
}

/** The product name ("Claude Code", "Codex") from the app's one agent-name table, never the raw id. */
function agentName(agent: string | null, t: Translate): string {
  const trimmed = agent?.trim()
  return trimmed ? cloudAgentLabel(trimmed) : t('cloud.snapshot.agentFallback', 'Agent')
}

/** Agents as they were when the workspace went to sleep; each opens to the tail of its chat. */
export function CloudReadSnapshotSessions({ sessions }: { sessions: ReadSnapshotSession[] }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  if (sessions.length === 0) {
    return null
  }
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(id)) {
        next.add(id)
      }
      return next
    })
  return (
    <View style={screen.card}>
      {sessions.map((session, index) => {
        const expanded = open.has(session.sessionId)
        const name = agentName(session.agent, t)
        const status = readSnapshotSessionStatus(session, t)
        const title = session.title?.trim() || name
        const meta = [title === name ? null : name, status].filter(Boolean).join(' · ')
        const Chevron = expanded ? ChevronDown : ChevronRight
        return (
          <View key={session.sessionId} style={index > 0 ? styles.rowDivider : undefined}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityLabel={[title, meta].filter(Boolean).join(', ')}
              accessibilityHint={t('cloud.snapshot.sessionHint', 'Shows the end of this chat')}
              onPress={() => toggle(session.sessionId)}
              style={({ pressed }) => [styles.row, pressed && screen.pressed]}
            >
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={2}>
                  {title}
                </Text>
                {meta ? (
                  <Text
                    style={[
                      styles.rowMeta,
                      session.status === 'attention' && styles.rowMetaAttention
                    ]}
                    numberOfLines={1}
                  >
                    {meta}
                  </Text>
                ) : null}
              </View>
              <Chevron size={18} color={colors.textMuted} />
            </Pressable>
            {expanded ? <Transcript session={session} agent={name} /> : null}
          </View>
        )
      })}
    </View>
  )
}

function Transcript({ session, agent }: { session: ReadSnapshotSession; agent: string }) {
  const t = useMobileTranslation()
  return (
    <View style={styles.transcript}>
      {session.truncated ? (
        <Text style={styles.truncatedNote}>
          {t('cloud.snapshot.truncated', 'Earlier messages aren’t in this copy.')}
        </Text>
      ) : null}
      {session.messages.length === 0 ? (
        <Text style={styles.truncatedNote}>
          {t('cloud.snapshot.noMessages', 'No messages in this chat yet.')}
        </Text>
      ) : (
        session.messages.map((message) => (
          <Bubble key={message.itemId} message={message} agent={agent} />
        ))
      )}
    </View>
  )
}

function Bubble({ message, agent }: { message: ReadSnapshotMessage; agent: string }) {
  const t = useMobileTranslation()
  if (message.role === 'user') {
    return (
      <View style={styles.bubbleUser}>
        <Text style={styles.roleLabel}>{t('cloud.snapshot.role.you', 'You')}</Text>
        <Text style={styles.userText} selectable>
          {message.text}
        </Text>
      </View>
    )
  }
  if (message.role === 'system') {
    return (
      <View style={styles.bubbleSystem}>
        <Text style={styles.roleLabel}>{t('cloud.snapshot.role.system', 'System')}</Text>
        <Text style={styles.systemText} selectable>
          {message.text}
        </Text>
      </View>
    )
  }
  return (
    <View style={styles.bubbleAssistant}>
      <Text style={styles.roleLabel}>{agent}</Text>
      <MobileNativeChatMarkdown content={message.text} />
    </View>
  )
}
