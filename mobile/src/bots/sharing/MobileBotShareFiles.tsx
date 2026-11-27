// A shared bot's parts as text: each file exactly as it goes out, numbered, its flagged lines marked,
// and the safety check's flag rows. The desktop's BotSharePartView and BotShareRows.
import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { ShieldAlert, TriangleAlert } from 'lucide-react-native'
import type { BotShareFlagSpot } from '../../../../src/shared/bots/bot-share-flag-spots'
import { LoadingSpinner } from '../../components/feedback/LoadingSpinner'
import { ListRow } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsNote } from '../../settings/settings-screen-frame'
import { radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botShareErrorMessage, botShareFlagLabel, botShareFlagWhere } from './bot-share-copy'
import { botShareView, type PhoneSharePartFile } from './bot-share-operations'

/** A flag's line under an item: red for a secret, amber otherwise. */
export function FlagLine(props: { secret: boolean; children: string }) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const color = props.secret ? colors.statusRed : colors.statusAmber
  const Icon = props.secret ? ShieldAlert : TriangleAlert
  return (
    <View style={styles.flagLine}>
      <Icon size={12} color={color} />
      <Text style={[styles.flagText, { color }]} numberOfLines={1}>
        {props.children}
      </Text>
    </View>
  )
}

/** One flag of the safety check: what it is and where, opening its text when a page shows it. */
export function FlagRow(props: { spot: BotShareFlagSpot; onOpen: (() => void) | null }) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const secret = props.spot.flag.kind === 'secret'
  const Icon = secret ? ShieldAlert : TriangleAlert
  return (
    <ListRow
      leading={<Icon size={18} color={secret ? colors.statusRed : colors.statusAmber} />}
      title={botShareFlagLabel(props.spot.flag.kind, t)}
      subtitle={botShareFlagWhere(props.spot, t)}
      navigates={props.onOpen !== null}
      onPress={props.onOpen ?? undefined}
    />
  )
}

/** A part's files, read from what the candidate was built from. */
export function SharePartFiles(props: {
  client: RpcClient | null
  botId: string
  candidateId: string
  part: string
  showNames: boolean
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const { client, botId, candidateId, part } = props
  const [files, setFiles] = useState<PhoneSharePartFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!client) {
      return
    }
    let current = true
    setFiles(null)
    setError(null)
    botShareView
      .request(client, { botId, candidateId, part })
      .then((reply) => botShareView.interpret(reply).files)
      .then(
        (read) => current && setFiles(read),
        (cause: unknown) => current && setError(botShareErrorMessage(cause))
      )
    return () => {
      current = false
    }
  }, [client, botId, candidateId, part])
  if (error) {
    return <SettingsNote error>{error}</SettingsNote>
  }
  if (!files) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size={18} color={colors.textMuted} />
      </View>
    )
  }
  return <ShareFileList files={files} showNames={props.showNames} />
}

/** A file's lines with their 1-based numbers; a line's number is its identity, as lines never move. */
function numberedLines(text: string): { number: number; line: string }[] {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line, index) => ({ number: index + 1, line }))
}

/** Files exactly as written, numbered, their flagged lines marked; a file's name above it when asked. */
export function ShareFileList(props: {
  files: readonly Pick<PhoneSharePartFile, 'path' | 'text' | 'flags'>[]
  showNames: boolean
}) {
  const t = useMobileTranslation()
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={styles.files}>
      {props.files.map((file) => {
        const flagged = new Map(file.flags.map((flag) => [flag.line, flag.kind]))
        const kinds = [...new Set(file.flags.map((flag) => flag.kind))]
        return (
          <View key={file.path} style={styles.file}>
            {props.showNames ? <Text style={styles.fileName}>{file.path}</Text> : null}
            {file.text === null ? (
              <Text style={styles.binary}>
                {t('bots.share.binaryFile', 'Not text, so it isn’t shown.')}
              </Text>
            ) : (
              <View style={styles.box}>
                {numberedLines(file.text).map(({ number, line }) => {
                  const kind = flagged.get(number)
                  return (
                    <View key={number} style={styles.line}>
                      <Text style={[styles.mono, styles.lineNumber]}>{number}</Text>
                      <Text
                        style={[
                          styles.mono,
                          styles.lineText,
                          kind && (kind === 'secret' ? styles.secretLine : styles.warningLine)
                        ]}
                      >
                        {line || ' '}
                      </Text>
                    </View>
                  )
                })}
              </View>
            )}
            {kinds.map((kind) => (
              <FlagLine key={kind} secret={kind === 'secret'}>
                {botShareFlagLabel(kind, t)}
              </FlagLine>
            ))}
          </View>
        )
      })}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  flagLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 2 },
  flagText: { fontSize: 13, flexShrink: 1 },
  loading: { paddingVertical: spacing.lg, alignItems: 'center' },
  files: { gap: spacing.md, paddingTop: spacing.sm },
  file: { gap: spacing.xs },
  fileName: {
    fontSize: 12,
    fontFamily: typography.monoFamily,
    color: colors.textSecondary,
    paddingHorizontal: spacing.xs
  },
  binary: { fontSize: 13, color: colors.textMuted, paddingHorizontal: spacing.xs },
  box: {
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.md
  },
  line: { flexDirection: 'row', gap: spacing.sm },
  mono: { fontSize: 12, lineHeight: 18, fontFamily: typography.monoFamily },
  lineNumber: { width: 22, textAlign: 'right', color: colors.textMuted },
  lineText: { flex: 1, color: colors.textPrimary },
  secretLine: { borderWidth: 1, borderColor: colors.statusRed, borderRadius: radii.mark },
  warningLine: { borderWidth: 1, borderColor: colors.statusAmber, borderRadius: radii.mark }
}))
